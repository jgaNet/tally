import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabaseUrl,
} from '../test-support';

const SECRET = 'shared-secret';

/** The day of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day)).toISOString().slice(0, 10);
}

describe('deleting an account', () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  /** The rows a query answers, read directly from the database the application keeps its state in. */
  async function rowsOf<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  const deleteOwnAccount = (token: string) => send(app, 'DELETE', '/accounts/me', { token });

  async function signIn(email: string, password: string) {
    return send(app, 'POST', '/accounts/login', { payload: { email, password } });
  }

  async function createdGroup(token: string, name = 'Flat'): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name, currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function recordExpense(token: string, groupId: string, overrides: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), ...overrides },
    });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  /**
   * Hal owns `Flat`, which Ada and Grace join. Grace paid 1000 split three ways, so Ada owes 333 of it to Grace, and
   * Grace has a payout account, as a payment through the provider needs.
   */
  async function flat() {
    const hal = await signedUpAccount(app, { email: 'hal@example.com', name: 'Hal' });
    const ada = await signedUpAccount(app, { name: 'Ada Lovelace' });
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const groupId = await createdGroup(hal.token);
    await joinThroughInvitation(app, hal.token, ada.token, groupId);
    await joinThroughInvitation(app, hal.token, grace.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
    const recorded = await recordExpense(grace.token, groupId, {
      amount: 1000,
      splitBetween: [ada.id, grace.id, hal.id],
    });
    expect(recorded.statusCode).toBe(201);
    return { hal, ada, grace, groupId };
  }

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  let counter = 0;
  /** The provider says `paymentId` has `status`, as a signed webhook. */
  function webhook(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    return app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
  }

  /** Ada pays Grace 300 through the provider, and the provider says it succeeded: the settlement is paid. */
  async function paidThroughProvider() {
    const { hal, ada, grace, groupId } = await flat();
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: grace.id, amount: 300 },
    });
    expect(asked.statusCode).toBe(201);
    const id = asked.json<{ id: string }>().id;
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    return { hal, ada, grace, groupId, id, paymentId };
  }

  describe('the deletion itself', () => {
    it('refuses a request without a token with 401', async () => {
      const response = await send(app, 'DELETE', '/accounts/me');
      expect(response.statusCode).toBe(401);
      expect((await deleteOwnAccount('not-a-real-token')).statusCode).toBe(401);
    });

    it('answers 204, and the account is gone: its sign-in, its token and a second deletion are refused', async () => {
      const ada = await signedUpAccount(app);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      expect((await signIn('ada@example.com', 'correct horse')).statusCode).toBe(401);
      expect((await signIn('ada@example.com', 'correct horse')).json().type).toBe('InvalidCredentials');
      expect((await send(app, 'GET', '/accounts/me', { token: ada.token })).statusCode).toBe(401);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(401);
    });

    it('does not let a deleted account be signed in as, whatever password is given with its email key', async () => {
      const ada = await signedUpAccount(app);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
      const attempt = await signIn(`deleted:${ada.id}`, 'any password at all');
      expect(attempt.statusCode).toBe(401);
      expect(attempt.json().type).toBe('InvalidCredentials');
    });

    it('frees its email: a new account may use it, and it is someone else', async () => {
      const ada = await signedUpAccount(app, { name: 'Ada Lovelace' });
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const created = await send(app, 'POST', '/accounts', {
        payload: { email: 'ada@example.com', password: 'another password', name: 'Ada Other' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ id: string }>().id).not.toBe(ada.id);

      const login = await signIn('ada@example.com', 'another password');
      expect(login.statusCode).toBe(200);
      const me = await send(app, 'GET', '/accounts/me', { token: login.json<{ token: string }>().token });
      expect(me.json()).toEqual({ id: created.json().id, email: 'ada@example.com', name: 'Ada Other' });
    });

    it('erases its name, its email and its password, keeps its id, and ends its sessions', async () => {
      const { hal, ada, groupId } = await flat();
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const [account] = await rowsOf<{
        id: string;
        email: string;
        name: string;
        password_hash: string;
        deleted_at: string | null;
      }>('SELECT id, email, name, password_hash, deleted_at FROM accounts WHERE id = $1', [ada.id]);
      expect(account).toEqual({
        id: ada.id,
        email: '',
        name: 'Deleted account',
        password_hash: '',
        deleted_at: expect.any(String),
      });
      expect(await rowsOf('SELECT 1 FROM sessions WHERE account_id = $1', [ada.id])).toEqual([]);

      const members = await send(app, 'GET', `/groups/${groupId}/members`, { token: hal.token });
      expect(members.json()).toContainEqual({
        memberId: ada.id,
        name: 'Deleted account',
        role: 'member',
        joinedAt: expect.any(String),
      });
      expect(JSON.stringify(members.json())).not.toContain('Lovelace');
    });

    it('keeps the id of a deleted account where the audit of its group names it', async () => {
      const { hal, ada, groupId } = await flat();
      const recorded = await recordExpense(ada.token, groupId, {
        description: 'Taxi',
        amount: 500,
        splitBetween: [ada.id],
      });
      expect(recorded.statusCode).toBe(201);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const audit = await send(app, 'GET', `/groups/${groupId}/audit`, { token: hal.token });
      expect(audit.json()).toContainEqual(
        expect.objectContaining({ by: ada.id, action: 'expense-recorded', amount: 500 }),
      );
    });
  });

  describe('what it refuses', () => {
    it('is refused while it owns a group with another member, and changes nothing', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const groupId = await createdGroup(ada.token, 'Own');
      await joinThroughInvitation(app, ada.token, grace.token, groupId);

      const refused = await deleteOwnAccount(ada.token);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('OwnsGroupWithMembers');
      expect((await signIn('ada@example.com', 'correct horse')).statusCode).toBe(200);
      expect((await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).statusCode).toBe(200);
    });

    it('is allowed for the owner of a group that has no other member, and the group stays', async () => {
      const ada = await signedUpAccount(app);
      const groupId = await createdGroup(ada.token, 'Solo');
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
      const rows = await rowsOf('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
      expect(rows).toEqual([{ owner_id: ada.id }]);
    });

    it('is refused while a payment it makes through the provider is pending, and while one it receives is', async () => {
      const { ada, grace, groupId } = await flat();
      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 300 },
      });
      expect(asked.statusCode).toBe(201);

      for (const account of [ada, grace]) {
        const refused = await deleteOwnAccount(account.token);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().type).toBe('PaymentPending');
      }
      expect((await signIn('grace@example.com', 'correct horse')).statusCode).toBe(200);
    });

    it('is refused while a refund the payee asked for is waiting at the provider', async () => {
      const { ada, grace, id } = await paidThroughProvider();
      expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token })).statusCode).toBeLessThan(
        300,
      );
      expect((await send(app, 'GET', `/settlements/${id}`, { token: ada.token })).json().status).toBe('refunding');

      const refused = await deleteOwnAccount(ada.token);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('PaymentPending');
    });

    it('is refused while a payment the payee contests is held', async () => {
      const { ada, grace, id } = await paidThroughProvider();
      expect((await send(app, 'POST', `/settlements/${id}/contest`, { token: grace.token })).statusCode).toBe(204);

      const refused = await deleteOwnAccount(grace.token);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('PaymentPending');
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(409);
    });

    it('is allowed once a payment through the provider it was in has failed', async () => {
      const { ada, grace, groupId } = await flat();
      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 300 },
      });
      const paymentId = provider.payments[provider.payments.length - 1].id;
      expect((await webhook(paymentId, 'failed')).statusCode).toBe(204);
      expect(asked.statusCode).toBe(201);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
    });
  });

  describe('what it leaves in its groups', () => {
    it('keeps its balance: it stays a member at its place, and the balances still add up to 0', async () => {
      const { hal, ada, groupId } = await flat();
      const before = await balancesOf(hal.token, groupId);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const after = await balancesOf(hal.token, groupId);
      expect(after).toEqual(before);
      expect(after.find(entry => entry.memberId === ada.id)?.balance).toBeLessThan(0);
      expect(after.reduce((total, entry) => total + entry.balance, 0)).toBe(0);
    });

    it('keeps its statement readable, as it was', async () => {
      const { hal, ada, groupId } = await flat();
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement`, { token: hal.token });
      expect(statement.statusCode).toBe(200);
      const owed = (await balancesOf(hal.token, groupId)).find(entry => entry.memberId === ada.id)?.balance;
      expect(statement.json()).toMatchObject({ memberId: ada.id, balance: owed });
    });

    it('is not put in a new expense, while an edit may keep it in one it already names', async () => {
      const { hal, ada, grace, groupId } = await flat();
      const existing = await recordExpense(grace.token, groupId, { amount: 600, splitBetween: [ada.id, grace.id] });
      expect(existing.statusCode).toBe(201);
      const expenseId = existing.json<{ id: string }>().id;
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const newOne = await recordExpense(hal.token, groupId, { amount: 600, splitBetween: [ada.id, hal.id] });
      expect(newOne.statusCode).toBe(422);
      expect(newOne.json().type).toBe('NotAMember');

      const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: grace.token,
        payload: {
          description: 'Dinner',
          amount: 600,
          date: todayInUtc(),
          splitBetween: [ada.id, grace.id],
          version: 1,
        },
      });
      expect(edited.statusCode).toBe(204);
    });

    it('is not paid through the provider, and a cash payment it made is still recorded by its payee', async () => {
      const { hal, ada, grace, groupId } = await flat();
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: hal.token,
        payload: { to: ada.id, amount: 100 },
      });
      expect(asked.statusCode).toBe(409);
      expect(asked.json().type).toBe('AccountDeleted');

      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 100 },
      });
      expect(cash.statusCode).toBe(201);
    });

    it('is not netted with, by any member', async () => {
      const { hal, ada } = await flat();
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
      const netted = await send(app, 'POST', '/nettings', {
        token: hal.token,
        payload: { with: ada.id, currency: 'EUR' },
      });
      expect(netted.statusCode).toBe(409);
      expect(netted.json().type).toBe('AccountDeleted');
    });

    it('ends a recurring expense it pays, or is in the split of, on its next day, and keeps the others', async () => {
      const { hal, ada, grace, groupId } = await flat();
      const startsOn = dayOfMonth(1, 5);
      const recurring = (token: string, description: string, splitBetween: string[]) =>
        send(app, 'POST', `/groups/${groupId}/recurring`, {
          token,
          payload: { description, amount: 90000, startsOn, splitBetween },
        });
      expect((await recurring(grace.token, 'Paid by Grace', [hal.id, grace.id])).statusCode).toBe(201);
      expect((await recurring(hal.token, 'Ada in the split', [hal.id, ada.id])).statusCode).toBe(201);
      expect((await recurring(hal.token, 'Kept', [hal.id])).statusCode).toBe(201);

      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);
      expect((await deleteOwnAccount(grace.token)).statusCode).toBe(204);
      await app.runJobs(new Date(`${startsOn}T08:00:00Z`));

      const left = await send(app, 'GET', `/groups/${groupId}/recurring`, { token: hal.token });
      expect(left.json<{ description: string }[]>().map(entry => entry.description)).toEqual(['Kept']);
      const recorded = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: hal.token });
      expect(recorded.json<{ description: string }[]>().map(expense => expense.description)).toEqual([
        'Kept',
        'Dinner',
      ]);
    });

    it('is told nothing: no budget notice and no reminder reaches it, while the others are', async () => {
      const { hal, ada, grace, groupId } = await flat();
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const budget = await send(app, 'PUT', `/groups/${groupId}/budgets/food`, {
        token: hal.token,
        payload: { amount: 1000 },
      });
      expect(budget.statusCode).toBe(204);
      const spent = await recordExpense(grace.token, groupId, {
        amount: 5000,
        category: 'food',
        splitBetween: [grace.id, hal.id],
      });
      expect(spent.statusCode).toBe(201);
      const budgetNotices = await rowsOf<{ account_id: string }>(
        "SELECT account_id FROM notices WHERE kind = 'budget' AND group_id = $1",
        [groupId],
      );
      expect(budgetNotices.map(row => row.account_id).sort()).toEqual([grace.id, hal.id].sort());
    });

    it('is reminded of no debt, though the others owing as much are', async () => {
      const { hal, ada, grace, groupId } = await flat();
      const split = await recordExpense(hal.token, groupId, {
        amount: 10000,
        splitBetween: [hal.id, ada.id, grace.id],
      });
      expect(split.statusCode).toBe(201);
      expect((await deleteOwnAccount(ada.token)).statusCode).toBe(204);

      const first = new Date();
      await app.runJobs(first);
      await app.runJobs(new Date(first.getTime() + 8 * 24 * 60 * 60 * 1000));

      const reminders = await rowsOf<{ account_id: string }>(
        "SELECT account_id FROM notices WHERE kind = 'reminder' AND group_id = $1",
        [groupId],
      );
      expect(reminders.map(row => row.account_id)).toEqual([grace.id]);
      expect(await rowsOf('SELECT 1 FROM noted_debts WHERE account_id = $1', [ada.id])).toEqual([]);
    });
  });
});
