import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplication, type Application } from './app';
import { type Database, openDatabase } from './database';
import { type TestDirectory, ensureDatabase, send, signedUpAccount, testDirectory } from './test-helpers';

const SECRET = 'shared with the provider';
const ADMIN_EMAIL = 'admin@example.org';
const WEEK_MS = 7 * 86_400_000;
/** The application's clock starts here: a recurring expense set up for this day is recorded at the first run. */
const START = Date.parse('2026-11-10T09:00:00.000Z');

/** Today's day in UTC, `YYYY-MM-DD`: the latest date an expense may have. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('deleting an account', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let provider: Server;
  let providerUrl: string;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;
  /** A payment number, for the fake provider's payment ids. */
  let nextPayment: number;

  beforeEach(async () => {
    now = START;
    nextPayment = 1;
    directory = testDirectory();
    // A fake provider that knows every account, and names each payment after its reference, as the webhooks do.
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        if (path.startsWith('/accounts/')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: decodeURIComponent(path.slice(10)) }));
          return;
        }
        const body = raw === '' ? undefined : (JSON.parse(raw) as { reference?: string });
        const n = nextPayment++;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: path.endsWith('/refunds') ? 're_1' : `pay_${body?.reference ?? n}`,
            payUrl: `https://pay.example.org/${n}`,
            fee: 0,
          }),
        );
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 1000,
      adminEmails: ADMIN_EMAIL,
      reminderPeriodSeconds: WEEK_MS / 1000,
      clock: () => new Date(now),
    });
    await app.start(0);
    // A second connection to the same database, to read what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string, currency = 'EUR'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /** Records an expense as `token`'s account, with `body`'s fields, answering the reply. */
  async function recordExpense(token: string, groupId: string, body: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount: 3000, date: utcDay(0), ...body },
    });
  }

  /** Records an expense that is split equally between `payer` and `other`, paid by `payer`, and answers its id. */
  async function expenseBetween(payer: { id: string; token: string }, other: { id: string }, groupId: string) {
    const reply = await recordExpense(payer.token, groupId, { splitBetween: [payer.id, other.id] });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `token` the one payments to it are made to, at the fake provider. */
  async function setPayoutAccount(token: string, accountId: string): Promise<void> {
    const reply = await send(app, 'PUT', '/accounts/me/payout-account', { token, body: { accountId } });
    if (reply.status !== 204) throw new Error(`payout account answered ${reply.status}`);
  }

  /** Asks the provider for a payment of `amount` from `payerToken`'s account to `to`, answering the reply. */
  async function askToPay(payerToken: string, groupId: string, to: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, { token: payerToken, body: { to, amount } });
  }

  /** Delivers the provider's signed webhook saying the payment of the settlement `id` is `status`. */
  async function say(id: string, status: string): Promise<void> {
    const body = JSON.stringify({
      id: `evt_${id}_${status}`,
      paymentId: `pay_${id}`,
      status,
      at: new Date().toISOString(),
    });
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    expect(response.status).toBe(204);
  }

  /** The balances of `groupId`, as `token`'s account reads them, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** The number of notices of `kind` the database holds for `accountId`. */
  async function noticesOfKind(accountId: string, kind: string): Promise<number> {
    const row = await db
      .prepare('SELECT COUNT(*) AS count FROM notices WHERE recipient_id = ? AND kind = ?')
      .get<{ count: number }>(accountId, kind);
    return row?.count ?? 0;
  }

  /** Deletes the account of `token`, answering the reply. */
  async function deleteAccount(token: string) {
    return send(app, 'DELETE', '/accounts/me', { token });
  }

  describe('answering the request', () => {
    it('answers 204 with nothing, and the token of the deleted account proves nothing', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const reply = await deleteAccount(ann.token);
      expect(reply.status).toBe(204);
      expect(reply.body).toBeUndefined();
      expect((await send(app, 'GET', '/accounts/me', { token: ann.token })).status).toBe(401);
      expect((await deleteAccount(ann.token)).status).toBe(401);
    });

    it('answers 401 to a request without a token, as before', async () => {
      expect((await send(app, 'DELETE', '/accounts/me')).status).toBe(401);
    });
  });

  describe('signing in', () => {
    it('lets nobody sign in with the deleted account email and password', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      await deleteAccount(ann.token);
      const login = await send(app, 'POST', '/accounts/login', {
        body: { email: 'ann@example.org', password: 'correct horse' },
      });
      expect(login.status).toBe(401);
      expect(login.body).toMatchObject({ error: 'CredentialsAreWrong' });
    });

    it('frees the email: a new account may use it, and it is someone else', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      await deleteAccount(ann.token);
      const again = await signedUpAccount(app, { email: 'Ann@Example.org', name: 'Anna' });
      expect(again.id).not.toBe(ann.id);
      expect(await send(app, 'GET', '/accounts/me', { token: again.token })).toMatchObject({
        status: 200,
        body: { id: again.id, email: 'Ann@Example.org', name: 'Anna' },
      });
    });
  });

  describe('what refuses the deletion', () => {
    it('refuses while the account owns a group that has another member, and allows it once they leave', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);

      const refused = await deleteAccount(ann.token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'GroupHasOtherMembers' });
      expect((await send(app, 'GET', '/accounts/me', { token: ann.token })).status).toBe(200);

      const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token });
      expect(left.status).toBe(204);
      expect((await deleteAccount(ann.token)).status).toBe(204);
    });

    it('refuses while a settlement through the provider that the account pays is pending, and allows it once the provider says it failed', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      await expenseBetween(ann, ben, groupId);
      await setPayoutAccount(ann.token, 'acct_ann');
      const asked = await askToPay(ben.token, groupId, ann.id, 1500);
      expect(asked.status).toBe(201);
      const settlementId = (asked.body as { id: string }).id;

      const refused = await deleteAccount(ben.token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'SettlementIsInProgress' });

      await say(settlementId, 'failed');
      expect((await deleteAccount(ben.token)).status).toBe(204);
    });

    it('refuses while a settlement through the provider that the account receives is contested, and allows it once an administrator decides', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const admin = await signedUpAccount(app, { email: ADMIN_EMAIL, name: 'Ada' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      await expenseBetween(ann, ben, groupId);
      await setPayoutAccount(ann.token, 'acct_ann');
      const settlementId = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
      await say(settlementId, 'succeeded');
      expect((await send(app, 'POST', `/settlements/${settlementId}/contest`, { token: ann.token })).status).toBe(204);

      const refused = await deleteAccount(ben.token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'SettlementIsInProgress' });

      const decided = await send(app, 'POST', `/admin/settlements/${settlementId}/decision`, {
        token: admin.token,
        body: { paid: true },
      });
      expect(decided.status).toBe(204);
      expect((await deleteAccount(ben.token)).status).toBe(204);
    });
  });

  describe('what is erased and what is kept', () => {
    it('names the deleted account `Deleted account` among the members, keeps its id, balance and expenses, and erases its name and email', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      const expenseId = await expenseBetween(ann, ben, groupId);
      expect((await deleteAccount(ben.token)).status).toBe(204);

      const members = (await send(app, 'GET', `/groups/${groupId}/members`, { token: ann.token })).body as {
        memberId: string;
        name: string;
        role: string;
      }[];
      expect(members).toEqual([
        expect.objectContaining({ memberId: ann.id, name: 'Ann', role: 'owner' }),
        expect.objectContaining({ memberId: ben.id, name: 'Deleted account', role: 'member' }),
      ]);

      const balances = await balancesAs(ann.token, groupId);
      expect(balances).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);

      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ben.id}/statement`, { token: ann.token });
      expect(statement.body).toMatchObject({ memberId: ben.id, balance: -1500, entries: [{ expenseId }] });

      const expense = await send(app, 'GET', `/expenses/${expenseId}`, { token: ann.token });
      expect(expense.body).toMatchObject({
        paidBy: ann.id,
        shares: [
          { memberId: ann.id, amount: 1500 },
          { memberId: ben.id, amount: 1500 },
        ],
      });

      const stored = await db
        .prepare('SELECT id, name, email, email_key, password_hash FROM accounts WHERE id = ?')
        .get<{ id: string; name: string; email: string; email_key: string; password_hash: string }>(ben.id);
      expect(stored).toMatchObject({ id: ben.id, name: 'Deleted account', email: '', password_hash: '' });
      expect(stored?.email_key).not.toContain('@');
      const leftover = await db
        .prepare("SELECT COUNT(*) AS count FROM accounts WHERE email_key = 'ben@example.org' OR name = 'Ben'")
        .get<{ count: number }>();
      expect(leftover?.count).toBe(0);
    });

    it('lets the others record in cash the payment they received from the deleted account, bringing the group to even', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      await expenseBetween(ann, ben, groupId);
      expect((await deleteAccount(ben.token)).status).toBe(204);

      const recorded = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ann.token,
        body: { from: ben.id, amount: 1500 },
      });
      expect(recorded.status).toBe(201);
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    });

    it('answers an administrator who suspends the deleted account as if no account had its id', async () => {
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const admin = await signedUpAccount(app, { email: ADMIN_EMAIL, name: 'Ada' });
      await deleteAccount(ben.token);
      const suspended = await send(app, 'PUT', `/admin/accounts/${ben.id}/suspension`, { token: admin.token });
      expect(suspended.status).toBe(404);
      expect(suspended.body).toMatchObject({ error: 'AccountNotFound' });
    });
  });

  describe('what can no longer happen to the deleted account', () => {
    it('is in no new split of an expense, a template or a recurring expense', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      await deleteAccount(ben.token);

      const expense = await recordExpense(ann.token, groupId, { splitBetween: [ann.id, ben.id] });
      expect(expense.status).toBe(422);
      expect(expense.body).toMatchObject({ error: 'MemberNotInGroup' });

      const template = await send(app, 'POST', `/groups/${groupId}/templates`, {
        token: ann.token,
        body: { name: 'Both', splitBetween: [ann.id, ben.id] },
      });
      expect(template.status).toBe(422);
      expect(template.body).toMatchObject({ error: 'MemberNotInGroup' });

      const recurring = await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ann.token,
        body: { description: 'Rent', amount: 1001, startsOn: '2026-11-10', splitBetween: [ann.id, ben.id] },
      });
      expect(recurring.status).toBe(422);
      expect(recurring.body).toMatchObject({ error: 'MemberNotInGroup' });

      // The account itself is no obstacle: the same expense without the deleted account is recorded.
      expect((await recordExpense(ann.token, groupId, { splitBetween: [ann.id] })).status).toBe(201);
    });

    it('is in no expense that is changed or deleted, which stays as it was', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      const expenseId = await expenseBetween(ann, ben, groupId);
      await deleteAccount(ben.token);

      const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ann.token,
        body: { version: 1, description: 'Dinner', amount: 3000, date: utcDay(0), splitBetween: [ann.id] },
      });
      expect(edited.status).toBe(409);
      expect(edited.body).toMatchObject({ error: 'AccountIsDeleted' });
      const deleted = await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ann.token });
      expect(deleted.status).toBe(409);
      expect(deleted.body).toMatchObject({ error: 'AccountIsDeleted' });

      const kept = await send(app, 'GET', `/expenses/${expenseId}`, { token: ann.token });
      expect(kept.body).toMatchObject({
        version: 1,
        amount: 3000,
        shares: [{ memberId: ann.id }, { memberId: ben.id }],
      });
    });

    it('is in no recurring expense: the recurring expense of a deleted member ends on its next day, nothing recorded', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ann.token,
        body: { description: 'Rent', amount: 1001, startsOn: '2026-11-10', splitBetween: [ann.id, ben.id] },
      });
      expect(created.status).toBe(201);
      const recurringId = (created.body as { id: string }).id;
      expect((await deleteAccount(ben.token)).status).toBe(204);

      await app.runJobs();
      expect((await send(app, 'GET', `/recurring/${recurringId}`, { token: ann.token })).status).toBe(404);
      const expenses = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ann.token });
      expect(expenses.body).toEqual([]);
    });

    it('is paid through the provider by no one, and netted with by no one', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      // Ben is owed by Ann, and has a payout account, which the deletion removes.
      await expenseBetween(ben, ann, groupId);
      await setPayoutAccount(ben.token, 'acct_ben');
      expect((await deleteAccount(ben.token)).status).toBe(204);

      const paid = await askToPay(ann.token, groupId, ben.id, 1500);
      expect(paid.status).toBe(422);
      expect(paid.body).toMatchObject({ error: 'AccountIsDeleted' });

      const netted = await send(app, 'POST', '/nettings', {
        token: ann.token,
        body: { with: ben.id, currency: 'EUR' },
      });
      expect(netted.status).toBe(422);
      expect(netted.body).toMatchObject({ error: 'AccountIsDeleted' });
    });

    it('tells it nothing any more: no reminder and no budget notice is made for it, while the others still get theirs', async () => {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
      const groupId = await createGroup(ann.token);
      await join(ann.token, groupId, ben.token);
      await join(ann.token, groupId, cy.token);
      // Each of Ben and Cy owes 2500 for a week: a reminder is due to each, unless deleted.
      const rent = await recordExpense(ann.token, groupId, { amount: 7500, splitBetween: [ann.id, ben.id, cy.id] });
      expect(rent.status).toBe(201);
      expect((await deleteAccount(ben.token)).status).toBe(204);
      expect(
        (await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { token: ann.token, body: { amount: 1000 } }))
          .status,
      ).toBe(204);

      await app.runJobs();
      now += WEEK_MS;
      await app.runJobs();
      expect(await noticesOfKind(cy.id, 'reminder')).toBe(1);
      expect(await noticesOfKind(ben.id, 'reminder')).toBe(0);

      const groceries = await recordExpense(ann.token, groupId, {
        amount: 2000,
        category: 'groceries',
        splitBetween: [ann.id],
      });
      expect(groceries.status).toBe(201);
      expect(await noticesOfKind(ann.id, 'budget')).toBe(1);
      expect(await noticesOfKind(cy.id, 'budget')).toBe(1);
      expect(await noticesOfKind(ben.id, 'budget')).toBe(0);
    });
  });
});
