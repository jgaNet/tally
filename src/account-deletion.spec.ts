import { createHmac } from 'node:crypto';
import { Application } from './app';
import {
  ada,
  call,
  FakeProvider,
  readRows,
  startApplication,
  startFakeProvider,
  temporaryDatabase,
} from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const administrator = { email: 'admin@example.com', password: 'administer-2026', name: 'Administrator' };

const PAST_DAY = '2026-11-01';
const SECRET = 'whsec_test';
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (days: number) => new Date(T0 + days * DAY);
// The provider's ids of Ada's and Grace's payout accounts.
const adaPayout = 'acct_ada';
const gracePayout = 'acct_grace';

describe('deleting an account', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let provider: FakeProvider;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let adminToken: string;
  let groupId: string;
  let dinnerId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string, group: string, inviterToken = adaToken): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${group}/invitations`, { token: inviterToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const remove = (token: string) => call(app, 'DELETE', '/accounts/me', { token });
  const balancesOf = (token = adaToken) => call(app, 'GET', `/groups/${groupId}/balances`, { token });
  const expensesOf = (token = adaToken) => call(app, 'GET', `/groups/${groupId}/expenses`, { token });

  /** Everything a group holds, as Ada reads it. Deleting an account must leave all of it as it was, but for the name. */
  async function groupState() {
    const read = async (path: string) =>
      (await call(app, 'GET', `/groups/${groupId}${path}`, { token: adaToken })).body;
    return {
      members: await read('/members'),
      balances: await read('/balances'),
      expenses: await read('/expenses'),
      settlements: await read('/settlements'),
      audit: await read('/audit'),
    };
  }

  /** The provider's id of the payment asked last: the fake provider numbers every request it gets. */
  const lastPaymentId = () => `pay_${provider.requests.length}`;

  const decide = (paymentId: string, status: string) => {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: '2026-11-20T10:00:00Z' });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  const sumOf = (rows: { balance: number }[]) => rows.reduce((sum, row) => sum + row.balance, 0);

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, {
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      adminEmails: [administrator.email],
    });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    adminToken = (await accountOf(administrator)).token;
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: gracePayout }, token: graceToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken, groupId);
    await join(linusToken, groupId);
    // Ada paid 1000 for Dinner: Ada is owed 600, Grace and Linus each owe 300.
    dinnerId = (
      await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: {
          description: 'Dinner',
          amount: 1000,
          date: PAST_DAY,
          splitExactly: [
            { memberId: adaId, amount: 400 },
            { memberId: graceId, amount: 300 },
            { memberId: linusId, amount: 300 },
          ],
        },
        token: adaToken,
      })
    ).body.id;
    // Grace paid 900 for Tea, split equally: Ada and Linus owe 300 each more, and Grace is owed 600.
    // Now Ada is owed 300, Grace is owed 300, and Linus owes 600.
    const tea = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Tea', amount: 900, date: PAST_DAY, splitBetween: [adaId, graceId, linusId] },
      token: graceToken,
    });
    expect(tea.status).toBe(201);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('when it is refused', () => {
    it('refuses an account that owns a group with another member, and changes nothing', async () => {
      const before = await groupState();
      expect(await remove(adaToken)).toEqual({
        status: 409,
        body: { type: 'OwnsGroupWithMembers', message: expect.any(String) },
      });
      expect((await call(app, 'GET', '/accounts/me', { token: adaToken })).status).toBe(200);
      expect((await call(app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
      expect(await groupState()).toEqual(before);
    });

    it('deletes the account of a member, and of the owner of a group that has no other member', async () => {
      const alone = (
        await call(app, 'POST', '/groups', { body: { name: 'Alone', currency: 'EUR' }, token: linusToken })
      ).body.id;
      expect(alone).toEqual(expect.any(String));
      expect((await remove(linusToken)).status).toBe(204);
    });

    it('refuses while a payment through the provider is waiting, by its payer or its payee', async () => {
      const payment = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: graceId, amount: 100 },
        token: linusToken,
      });
      expect(payment.status).toBe(201);
      expect(await remove(linusToken)).toEqual({
        status: 409,
        body: { type: 'SettlementWaiting', message: expect.any(String) },
      });
      expect(await remove(graceToken)).toEqual({
        status: 409,
        body: { type: 'SettlementWaiting', message: expect.any(String) },
      });
    });

    it('refuses while a refund or a contested payment through the provider is waiting', async () => {
      // Linus pays Grace 100 through the provider, which says it succeeded; Grace refunds it, and the refund is waiting.
      const first = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: graceId, amount: 100 },
        token: linusToken,
      });
      expect(first.status).toBe(201);
      const firstPayment = lastPaymentId();
      expect((await decide(firstPayment, 'succeeded')).status).toBe(204);
      expect((await call(app, 'POST', `/settlements/${first.body.id}/refund`, { token: graceToken })).status).toBe(204);
      expect(await remove(linusToken)).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });
      expect(await remove(graceToken)).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });

      // The provider says it is refunded: nothing waits any more, for Grace.
      expect((await decide(firstPayment, 'refunded')).status).toBe(204);

      // Linus pays Grace 50 through the provider, which says it succeeded; Grace contests it, and it is contested.
      const second = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: graceId, amount: 50 },
        token: linusToken,
      });
      expect(second.status).toBe(201);
      expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);
      expect((await call(app, 'POST', `/settlements/${second.body.id}/contest`, { token: graceToken })).status).toBe(
        204,
      );
      expect(await remove(linusToken)).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });
      expect(await remove(graceToken)).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });
    });

    it('deletes an account once the provider has decided its payments', async () => {
      const payment = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: graceId, amount: 100 },
        token: linusToken,
      });
      expect(payment.status).toBe(201);
      expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);
      expect((await remove(linusToken)).status).toBe(204);
    });
  });

  describe('once deleted', () => {
    it('signs the account out, refuses it to sign in, and frees its email for another account, which is someone else', async () => {
      expect((await remove(graceToken)).status).toBe(204);

      expect((await call(app, 'GET', '/accounts/me', { token: graceToken })).status).toBe(401);
      expect((await call(app, 'GET', `/groups/${groupId}/members`, { token: graceToken })).status).toBe(401);
      expect((await remove(graceToken)).status).toBe(401);
      expect(await call(app, 'POST', '/accounts/login', { body: grace })).toEqual({
        status: 401,
        body: { type: 'InvalidCredentials', message: expect.any(String) },
      });

      const again = await call(app, 'POST', '/accounts', {
        body: { email: grace.email, password: 'a-new-password', name: 'Grace Again' },
      });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(graceId);
      const token = (
        await call(app, 'POST', '/accounts/login', { body: { email: grace.email, password: 'a-new-password' } })
      ).body.token;
      expect(await call(app, 'GET', '/accounts/me', { token })).toEqual({
        status: 200,
        body: { id: again.body.id, email: grace.email, name: 'Grace Again' },
      });
      expect((await call(app, 'GET', '/groups/mine', { token })).body).toEqual([]);
    });

    it('erases the name and the email, keeps the id, its place, role and balance in each group, and the balances at 0', async () => {
      const before = await groupState();
      expect((await remove(graceToken)).status).toBe(204);

      const after = await groupState();
      // The members list names the account `Deleted account`, at the same place, with the same role and join date.
      expect(after.members).toEqual(
        before.members.map((member: { memberId: string }) =>
          member.memberId === graceId ? { ...member, name: 'Deleted account' } : member,
        ),
      );
      // Everything else the group holds reads as before.
      expect({ ...after, members: undefined }).toEqual({ ...before, members: undefined });
      expect(sumOf(after.balances)).toBe(0);
      expect(after.balances).toContainEqual({ memberId: graceId, balance: 300 });

      // The statement of the account reads as before.
      const statement = await call(app, 'GET', `/groups/${groupId}/members/${graceId}/statement`, { token: adaToken });
      expect(statement.status).toBe(200);
      expect(statement.body.balance).toBe(300);

      const [row] = await readRows(
        database.url,
        'SELECT name, email, password_hash, deleted_at FROM accounts WHERE id = ?',
        [graceId],
      );
      expect(row).toEqual({
        name: 'Deleted account',
        email: null,
        password_hash: null,
        deleted_at: expect.any(String),
      });
      const [sessions] = await readRows(database.url, 'SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', [
        graceId,
      ]);
      expect(Number(sessions.n)).toBe(0);
      const [payouts] = await readRows(database.url, 'SELECT COUNT(*) AS n FROM payout_accounts WHERE account_id = ?', [
        graceId,
      ]);
      expect(Number(payouts.n)).toBe(0);
    });

    it('keeps the account as a member, in the group where it has a balance, without any change to the others', async () => {
      const before = (await balancesOf()).body;
      expect((await remove(graceToken)).status).toBe(204);
      expect((await balancesOf()).body).toEqual(before);
      expect((await expensesOf()).body).toHaveLength(2);
    });
  });

  describe('what the account can no longer do', () => {
    it('is not put in the split of a new expense, of a recurring expense or of a template', async () => {
      expect((await remove(graceToken)).status).toBe(204);
      const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Snack', amount: 600, date: PAST_DAY, splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(expense).toEqual({ status: 422, body: { type: 'InvalidSplit', message: expect.any(String) } });
      const recurring = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1000, startsOn: '2026-11-20', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(recurring.status).toBe(422);
      const template = await call(app, 'POST', `/groups/${groupId}/templates`, {
        body: { name: 'Pair', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(template.status).toBe(422);
    });

    it('may still be edited into an expense that already has it, but is not added to one', async () => {
      const lunch = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Lunch', amount: 1000, date: PAST_DAY, splitBetween: [adaId, linusId] },
        token: adaToken,
      });
      expect(lunch.status).toBe(201);
      expect((await remove(graceToken)).status).toBe(204);

      const edit = (fields: Record<string, unknown>) =>
        call(app, 'PUT', `/expenses/${dinnerId}`, {
          body: {
            description: 'Dinner, again',
            amount: 1000,
            date: PAST_DAY,
            version: 1,
            splitExactly: [
              { memberId: adaId, amount: 400 },
              { memberId: graceId, amount: 300 },
              { memberId: linusId, amount: 300 },
            ],
            ...fields,
          },
          token: adaToken,
        });
      expect((await edit({})).status).toBe(204);
      const refused = await call(app, 'PUT', `/expenses/${lunch.body.id}`, {
        body: {
          description: 'Lunch',
          amount: 1000,
          date: PAST_DAY,
          version: 1,
          splitBetween: [adaId, graceId, linusId],
        },
        token: adaToken,
      });
      expect(refused).toEqual({ status: 422, body: { type: 'InvalidSplit', message: expect.any(String) } });
    });

    it('is not paid through the provider, nor netted with, but a payment in cash from it is still recorded', async () => {
      expect((await remove(linusToken)).status).toBe(204);

      const paid = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: linusId, amount: 100 },
        token: graceToken,
      });
      expect(paid).toEqual({ status: 409, body: { type: 'AccountDeleted', message: expect.any(String) } });
      expect(provider.requests).toEqual([]);

      // Linus owes 600 and Grace is owed 300, so the two could net 300 of it, were Linus not deleted.
      const netted = await call(app, 'POST', '/nettings', {
        body: { with: linusId, currency: 'EUR' },
        token: graceToken,
      });
      expect(netted).toEqual({ status: 409, body: { type: 'AccountDeleted', message: expect.any(String) } });

      // Linus owes 600 and Ada is owed 300: Ada records the 300 Linus paid in cash, so the group comes back to even.
      const cash = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: linusId, amount: 300 },
        token: adaToken,
      });
      expect(cash.status).toBe(201);
      expect((await balancesOf()).body).toEqual(
        expect.arrayContaining([
          { memberId: adaId, balance: 0 },
          { memberId: linusId, balance: -300 },
        ]),
      );
    });

    it('is not sent a recurring expense on its day: the recurring expense it pays, or is in the split of, ends', async () => {
      const rent = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1000, startsOn: '2026-11-20', splitBetween: [linusId, graceId, adaId] },
        token: linusToken,
      });
      expect(rent.status).toBe(201);
      const gym = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Gym', amount: 500, startsOn: '2026-11-20', splitBetween: [graceId, adaId] },
        token: graceToken,
      });
      expect(gym.status).toBe(201);
      const internet = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Internet', amount: 300, startsOn: '2026-11-20', splitBetween: [adaId, linusId] },
        token: adaToken,
      });
      expect(internet.status).toBe(201);
      const before = (await expensesOf()).body.length;

      expect((await remove(graceToken)).status).toBe(204);
      await app.runJobs(new Date('2026-11-20T12:00:00Z'));

      // Rent, in the split of Grace, and Gym, paid by Grace, end on their day, recording nothing; Internet is recorded.
      const recurring = (await call(app, 'GET', `/groups/${groupId}/recurring`, { token: adaToken })).body;
      expect(recurring.map((row: { description: string }) => row.description)).toEqual(['Internet']);
      const expenses = (await expensesOf()).body;
      expect(expenses).toHaveLength(before + 1);
      expect(expenses[0]).toMatchObject({ description: 'Internet', paidBy: adaId });
    });

    it('is not reminded of a debt it has, once deleted', async () => {
      // Ada records a large expense for Grace, and Linus, so that both owe more than 2000: the job notes them.
      const trip = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Trip', amount: 12000, date: PAST_DAY, splitBetween: [adaId, graceId, linusId] },
        token: adaToken,
      });
      expect(trip.status).toBe(201);
      await app.runJobs(at(0));
      expect((await remove(graceToken)).status).toBe(204);

      // The job reminds the one of them still a member after a week; a deleted account is not reminded.
      await app.runJobs(at(8));
      const [reminders] = await readRows(
        database.url,
        "SELECT COUNT(*) AS n FROM notices WHERE kind = 'reminder' AND account_id = ?",
        [graceId],
      );
      expect(Number(reminders.n)).toBe(0);
      const linusReminders = await readRows(
        database.url,
        "SELECT account_id FROM notices WHERE kind = 'reminder' AND account_id = ?",
        [linusId],
      );
      expect(linusReminders).toHaveLength(1);
    });

    it('tells no one a budget passed except the members who still have an account', async () => {
      expect((await remove(graceToken)).status).toBe(204);
      expect(
        (await call(app, 'PUT', `/groups/${groupId}/budgets/food`, { body: { amount: 100 }, token: adaToken })).status,
      ).toBe(204);
      const lunch = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Lunch', amount: 1000, date: PAST_DAY, category: 'food', splitBetween: [adaId, linusId] },
        token: adaToken,
      });
      expect(lunch.status).toBe(201);
      const notified = await readRows(
        database.url,
        "SELECT account_id FROM notices WHERE kind = 'budget' ORDER BY account_id",
      );
      expect(notified.map(row => row.account_id).sort()).toEqual([adaId, linusId].sort());
    });

    it('is as if no account had its id to an administrator suspending it', async () => {
      expect((await remove(graceToken)).status).toBe(204);
      const answer = await call(app, 'PUT', `/admin/accounts/${graceId}/suspension`, { token: adminToken });
      expect(answer).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
    });
  });
});
