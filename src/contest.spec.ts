import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { type Application, createApplication } from './app';
import { type TestDirectory, ensureDatabase, send, signedUpAccount, testDirectory } from './test-helpers';

const SECRET = 'shared with the provider';
const ADMIN_EMAILS = 'Admin@Example.org, second@example.org';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('contesting a settlement through the provider, and the administrators deciding it', () => {
  let directory: TestDirectory;
  let app: Application;
  let provider: Server;
  let providerUrl: string;

  /**
   * A fake provider: it knows every account, and answers a payment with the id `pay_<reference>`, the reference being the
   * settlement's id, so a test can name the payment of a settlement without reading the database.
   */
  beforeEach(async () => {
    directory = testDirectory();
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        const body = raw === '' ? {} : (JSON.parse(raw) as { reference?: string });
        if (path.startsWith('/accounts/')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: decodeURIComponent(path.slice('/accounts/'.length)) }));
        } else if (path === '/payments') {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ id: `pay_${body.reference}`, payUrl: `https://pay.example.org/${body.reference}` }),
          );
        } else {
          response.writeHead(404);
          response.end();
        }
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
      adminEmails: ADMIN_EMAILS,
    });
    await app.start(0);
  });

  afterEach(async () => {
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency: 'EUR' } });
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

  /**
   * Ann and Ben in a group: Ann paid 3000 split equally, so Ben owes Ann 1500. Ann, the payee in these tests, has a
   * payout account, as a payment through the provider needs.
   */
  async function annAndBenOwing1500() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 3000, date: utcDay(0), splitBetween: [ann.id, ben.id] },
    });
    if (expense.status !== 201) throw new Error(`record answered ${expense.status}`);
    const payout = await send(app, 'PUT', '/accounts/me/payout-account', {
      token: ann.token,
      body: { accountId: `acct_${ann.id}` },
    });
    if (payout.status !== 204) throw new Error(`payout account answered ${payout.status}`);
    return { ann, ben, groupId };
  }

  /** Asks the provider for a payment of `amount` from `payerToken`'s account to `to`, and answers the settlement's id. */
  async function askToPay(payerToken: string, groupId: string, to: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, { token: payerToken, body: { to, amount } });
  }

  /** Delivers the provider's signed webhook saying the payment of the settlement `id` is `status`, and expects it acknowledged. */
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

  /** Ben pays Ann 1500 through the provider and the provider says it succeeded: the balances are 0. */
  async function benPaidAnn() {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    await say(id, 'succeeded');
    return { ann, ben, groupId, id };
  }

  /** The settlement `id`, as `token`'s account reads it. */
  async function readSettlement(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  /** The balances of `groupId`, as `token`'s account reads them, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** The suggested settlements of `groupId`, as `token`'s account reads them. */
  async function suggestionsAs(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token });
    return reply.body as { from: string; to: string; amount: number }[];
  }

  /** The audit of `groupId`, as `token`'s account reads it. */
  async function auditAs(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    return reply.body as { by: string; action: string; subjectId: string; amount: number }[];
  }

  /** The payee's contest of the settlement `id`. */
  async function contest(token: string, id: string) {
    return send(app, 'POST', `/settlements/${id}/contest`, { token });
  }

  /** The administrator's decision on the settlement `id`, with `paid` as the body gives it. */
  async function decide(token: string, id: string, paid: unknown) {
    return send(app, 'POST', `/admin/settlements/${id}/decision`, { token, body: { paid } });
  }

  /** The administrator account, which signs up with the email in lowercase, while ADMIN_EMAILS names it in mixed case. */
  async function administrator() {
    return signedUpAccount(app, { email: 'admin@example.org', name: 'Ada' });
  }

  describe('contesting', () => {
    it('lets the payee contest a settlement through the provider that is paid, and keeps it contested, with its history', async () => {
      const { ann, ben, id } = await benPaidAnn();

      const reply = await contest(ann.token, id);
      expect(reply.status).toBe(204);
      const settlement = (await readSettlement(ben.token, id)).body as {
        status: string;
        method: string;
        history: { status: string }[];
      };
      expect(settlement).toMatchObject({ status: 'contested', method: 'provider' });
      expect(settlement.history.map(change => change.status)).toEqual(['pending', 'paid', 'contested']);
    });

    it('holds its effect: the balances are as they were before it was paid, and what is still owed waits for it', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });

      expect((await contest(ann.token, id)).status).toBe(204);

      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      // Waiting, it counts as paid for what the payer still owes: nothing is suggested, and nothing more can be asked.
      expect(await suggestionsAs(ben.token, groupId)).toEqual([]);
      const again = await askToPay(ben.token, groupId, ann.id, 1500);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'AmountExceedsBalance' });
    });

    it('refuses a contest by the payer or another member with 403, and by one outside the group with 404, and changes nothing', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
      const outsider = await signedUpAccount(app, { email: 'out@example.org', name: 'Out' });
      await join(ann.token, groupId, cy.token);

      expect((await contest(ben.token, id)).status).toBe(403);
      expect((await contest(cy.token, id)).status).toBe(403);
      expect((await contest(outsider.token, id)).status).toBe(404);
      expect((await readSettlement(ann.token, id)).body).toMatchObject({ status: 'paid' });
    });

    it('refuses a contest of a settlement not paid through the provider, with 409, and changes nothing', async () => {
      const { ann, ben, groupId } = await annAndBenOwing1500();
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ann.token,
        body: { from: ben.id, amount: 1000 },
      });
      const cashId = (cash.body as { id: string }).id;
      expect((await contest(ann.token, cashId)).body).toMatchObject({ error: 'NotPaidThroughProvider' });

      // Ben owes 500 now that 1000 was paid in cash: the payment through the provider is the rest.
      const pending = ((await askToPay(ben.token, groupId, ann.id, 500)).body as { id: string }).id;
      expect((await contest(ann.token, pending)).body).toMatchObject({ error: 'SettlementIsNotPaid' });
      expect((await readSettlement(ann.token, pending)).body).toMatchObject({ status: 'pending' });
    });

    it('lets the payee contest a settlement once: a second contest is refused, even after an administrator says it was paid', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      const admin = await administrator();
      expect((await contest(ann.token, id)).status).toBe(204);

      expect((await contest(ann.token, id)).body).toMatchObject({ error: 'SettlementIsNotPaid' });
      expect((await decide(admin.token, id, true)).status).toBe(204);
      const again = await contest(ann.token, id);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'SettlementWasContested' });
      expect((await readSettlement(ann.token, id)).body).toMatchObject({ status: 'paid' });
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    });

    it('refuses a contest once its payer or payee has left the group, and changes nothing', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      // Paid and not waiting, Ben's balance is 0, so he may leave.
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(204);

      expect((await contest(ann.token, id)).body).toMatchObject({ error: 'MemberHasLeft' });
      expect((await readSettlement(ann.token, id)).body).toMatchObject({ status: 'paid' });
    });

    it('acknowledges a webhook about the payment of a contested settlement, and changes nothing', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      await contest(ann.token, id);

      await say(id, 'refunded');
      await say(id, 'failed');
      await say(id, 'succeeded');

      expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'contested' });
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
    });

    it('holds the leaving of its payer and payee, and the merging of its group, until an administrator decides it', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      await contest(ann.token, id);

      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).body).toMatchObject({
        error: 'SettlementIsInProgress',
      });
      const other = await createGroup(ann.token);
      expect(
        (await send(app, 'POST', `/groups/${other}/merge`, { token: ann.token, body: { from: groupId } })).body,
      ).toMatchObject({
        error: 'SettlementIsInProgress',
      });
    });
  });

  it('takes a database created before contests, whose CHECKs lack their statuses and actions, and lets a settlement be contested in it', async () => {
    const { ann, ben, groupId, id } = await benPaidAnn();
    await app.stop();
    // The CHECKs as a database created before contests had them.
    const client = new pg.Client({ connectionString: directory.databaseUrl });
    await client.connect();
    try {
      await client.query(
        `ALTER TABLE settlements DROP CONSTRAINT settlements_status_check,
           ADD CONSTRAINT settlements_status_check CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded'))`,
      );
      await client.query(
        `ALTER TABLE settlement_statuses DROP CONSTRAINT settlement_statuses_status_check,
           ADD CONSTRAINT settlement_statuses_status_check CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded'))`,
      );
      await client.query(
        `ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_action_check,
           ADD CONSTRAINT audit_entries_action_check CHECK (action IN ('expense-recorded', 'expense-edited', 'expense-deleted',
             'settlement-paid', 'settlement-refunded', 'balance-passed'))`,
      );
    } finally {
      await client.end();
    }
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
      adminEmails: ADMIN_EMAILS,
    });
    await app.start(0);

    expect((await contest(ann.token, id)).status).toBe(204);
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'contested' });
    expect((await auditAs(ann.token, groupId)).map(entry => entry.action)).toContain('settlement-contested');
  });

  describe('deciding', () => {
    it('lists the settlements contested now, the earliest contested first, each as its settlement reads', async () => {
      const { ann, ben, groupId } = await annAndBenOwing1500();
      const first = ((await askToPay(ben.token, groupId, ann.id, 1000)).body as { id: string }).id;
      await say(first, 'succeeded');
      const second = ((await askToPay(ben.token, groupId, ann.id, 500)).body as { id: string }).id;
      await say(second, 'succeeded');
      // The later settlement is contested first, so it is listed first.
      expect((await contest(ann.token, second)).status).toBe(204);
      expect((await contest(ann.token, first)).status).toBe(204);

      const admin = await administrator();
      const listed = await send(app, 'GET', '/admin/contests', { token: admin.token });
      expect(listed.status).toBe(200);
      const expected = [(await readSettlement(ann.token, second)).body, (await readSettlement(ann.token, first)).body];
      expect(listed.body).toEqual(expected);
    });

    it('refuses a non-administrator the list and the log with 404, as if the routes did not exist, and one not signed in with 401', async () => {
      const { ann, ben, id } = await benPaidAnn();
      await contest(ann.token, id);

      expect((await send(app, 'GET', '/admin/contests', { token: ann.token })).status).toBe(404);
      expect((await send(app, 'GET', '/admin/log', { token: ben.token })).status).toBe(404);
      expect((await send(app, 'GET', '/admin/contests')).status).toBe(401);
      expect((await send(app, 'GET', '/admin/log')).status).toBe(401);
    });

    it('refuses a decision by one who is not an administrator with 403, and changes nothing', async () => {
      const { ann, ben, id } = await benPaidAnn();
      await contest(ann.token, id);

      expect((await decide(ann.token, id, true)).status).toBe(403);
      expect((await decide(ben.token, id, false)).status).toBe(403);
      expect((await readSettlement(ann.token, id)).body).toMatchObject({ status: 'contested' });
    });

    it('refuses to decide a settlement that is not contested, or one that is not there, with 409 and 404, and decides a contested one once', async () => {
      const { ann, id } = await benPaidAnn();
      const admin = await administrator();

      expect((await decide(admin.token, id, true)).body).toMatchObject({ error: 'SettlementIsNotContested' });
      expect((await decide(admin.token, '00000000-0000-4000-8000-000000000000', true)).status).toBe(404);

      await contest(ann.token, id);
      expect((await decide(admin.token, id, true)).status).toBe(204);
      expect((await decide(admin.token, id, false)).body).toMatchObject({ error: 'SettlementIsNotContested' });
    });

    it('refuses a decision whose paid is not a boolean, with 400', async () => {
      const { ann, id } = await benPaidAnn();
      await contest(ann.token, id);
      const admin = await administrator();

      expect((await decide(admin.token, id, 'yes')).status).toBe(400);
      expect(
        (await send(app, 'POST', `/admin/settlements/${id}/decision`, { token: admin.token, body: {} })).status,
      ).toBe(400);
      expect((await readSettlement(ann.token, id)).body).toMatchObject({ status: 'contested' });
    });

    it('an administrator decides a contested settlement was paid: it counts as before, and the audit and the log say so', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      await contest(ann.token, id);
      const admin = await administrator();

      expect((await decide(admin.token, id, true)).status).toBe(204);

      const settlement = (await readSettlement(ben.token, id)).body as {
        status: string;
        history: { status: string }[];
      };
      expect(settlement.status).toBe('paid');
      expect(settlement.history.map(change => change.status)).toEqual(['pending', 'paid', 'contested', 'paid']);
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
      expect(await suggestionsAs(ann.token, groupId)).toEqual([]);

      const audit = await auditAs(ann.token, groupId);
      expect(audit.map(entry => entry.action)).toEqual([
        'expense-recorded',
        'settlement-paid',
        'settlement-contested',
        'settlement-paid',
      ]);
      expect(audit[2]).toMatchObject({ by: ann.id, subjectId: id, amount: 1500 });
      expect(audit[3]).toMatchObject({ by: admin.id, subjectId: id, amount: 1500 });

      expect((await send(app, 'GET', '/admin/log', { token: admin.token })).body).toEqual([
        { id: expect.any(String), at: expect.any(String), by: admin.id, action: 'decided-paid', subjectId: id },
      ]);
    });

    it('an administrator decides a contested settlement was not paid: it is annulled, nothing counts it, and what was owed is owed again', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      await contest(ann.token, id);
      const admin = await administrator();

      expect((await decide(admin.token, id, false)).status).toBe(204);

      const settlement = (await readSettlement(ben.token, id)).body as {
        status: string;
        history: { status: string }[];
      };
      expect(settlement.status).toBe('annulled');
      expect(settlement.history.map(change => change.status)).toEqual(['pending', 'paid', 'contested', 'annulled']);
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      expect(await suggestionsAs(ben.token, groupId)).toEqual([{ from: ben.id, to: ann.id, amount: 1500 }]);
      // The annulled settlement is no entry of the audit: only its contest was.
      expect((await auditAs(ann.token, groupId)).map(entry => entry.action)).toEqual([
        'expense-recorded',
        'settlement-paid',
        'settlement-contested',
      ]);
      expect((await askToPay(ben.token, groupId, ann.id, 1500)).status).toBe(201);
      expect((await send(app, 'GET', '/admin/log', { token: admin.token })).body).toEqual([
        { id: expect.any(String), at: expect.any(String), by: admin.id, action: 'decided-annulled', subjectId: id },
      ]);
    });

    it('lets the payer leave once an administrator has annulled the contest, which holds them until then', async () => {
      const { ann, ben, groupId, id } = await benPaidAnn();
      await contest(ann.token, id);
      const admin = await administrator();
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(409);

      expect((await decide(admin.token, id, false)).status).toBe(204);

      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(204);
    });

    it('reads the administrators’ log oldest first, and a decision is kept as it was made', async () => {
      const { ann, ben, groupId } = await annAndBenOwing1500();
      const paid = ((await askToPay(ben.token, groupId, ann.id, 1000)).body as { id: string }).id;
      await say(paid, 'succeeded');
      const annulled = ((await askToPay(ben.token, groupId, ann.id, 500)).body as { id: string }).id;
      await say(annulled, 'succeeded');
      await contest(ann.token, paid);
      await contest(ann.token, annulled);
      const admin = await administrator();
      expect((await decide(admin.token, annulled, false)).status).toBe(204);
      expect((await decide(admin.token, paid, true)).status).toBe(204);

      const log = (await send(app, 'GET', '/admin/log', { token: admin.token })).body;
      expect(log).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: admin.id,
          action: 'decided-annulled',
          subjectId: annulled,
        },
        { id: expect.any(String), at: expect.any(String), by: admin.id, action: 'decided-paid', subjectId: paid },
      ]);
      expect((await send(app, 'GET', '/admin/log', { token: admin.token })).body).toEqual(log);
    });
  });
});
