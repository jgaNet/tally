import { createHmac } from 'node:crypto';
import { Application } from './app';
import {
  ada,
  Answer,
  call,
  FakeProvider,
  startApplication,
  startFakeProvider,
  temporaryDatabase,
} from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const AT = '2026-11-20T10:00:00Z';
const SECRET = 'whsec_test';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe("a group's settlements, and the history of each", () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const askProvider = (body: unknown, token: string): Promise<Answer> =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const recordCash = (body: unknown, token: string): Promise<Answer> =>
    call(app, 'POST', `/groups/${groupId}/settlements/cash`, { body, token });

  const settlementOf = async (settlementId: string, token = adaToken) =>
    (await call(app, 'GET', `/settlements/${settlementId}`, { token })).body;

  /** A webhook as the provider sends it, signed with the secret. */
  function decide(paymentId: string, status: string, id = `wh_${paymentId}_${status}`): Promise<Answer> {
    const raw = JSON.stringify({ id, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  }

  /** The statuses of a history, the earliest first. */
  const statusesOf = (settlement: { history: { status: string }[] }) => settlement.history.map(entry => entry.status);

  /** Grace asks to pay Ada 1000 through the provider; the provider's payment is `pay_1`. Answers the settlement's id. */
  async function graceAsksAda(): Promise<string> {
    const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    // Ada is paid through the provider, on her payout account. Setting it asks the provider, which is not a payment.
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: 'acct_ada' }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
    // Ada paid 3000, split equally: Ada is owed 2000, Grace and Linus each owe 1000.
    const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Dinner',
        amount: 3000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 1000 },
          { memberId: graceId, amount: 1000 },
          { memberId: linusId, amount: 1000 },
        ],
      },
      token: adaToken,
    });
    expect(expense.status).toBe(201);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('the list of the group', () => {
    it('lists the settlements of the group the most recent first, each as it reads on its own', async () => {
      const provided = await graceAsksAda();
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      const cash = await recordCash({ from: linusId, amount: 500 }, adaToken);
      expect(cash.status).toBe(201);

      const list = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: linusToken });
      expect(list.status).toBe(200);
      expect(list.body).toEqual([
        await settlementOf(cash.body.id, linusToken),
        await settlementOf(provided, linusToken),
      ]);
      expect(list.body.map((settlement: { id: string }) => settlement.id)).toEqual([cash.body.id, provided]);
    });

    it('lists nothing for a group with no settlement yet', async () => {
      const list = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: adaToken });
      expect(list).toEqual({ status: 200, body: [] });
    });

    it('lists the settlements of a member who has left the group to those who remain', async () => {
      const cash = await recordCash({ from: linusId, amount: 1000 }, adaToken);
      expect(cash.status).toBe(201);
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);

      const list = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: graceToken });
      expect(list.status).toBe(200);
      expect(list.body).toEqual([await settlementOf(cash.body.id, graceToken)]);
    });

    it('refuses the group to an account that is not a member, and to one that does not exist', async () => {
      await recordCash({ from: linusId, amount: 500 }, adaToken);
      const outsider = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: outsiderToken });
      expect(outsider).toMatchObject({ status: 404, body: { type: 'NotFound' } });
      const missing = await call(app, 'GET', '/groups/no-such-group/settlements', { token: adaToken });
      expect(missing).toMatchObject({ status: 404, body: { type: 'NotFound' } });
      expect((await call(app, 'GET', `/groups/${groupId}/settlements`)).status).toBe(401);
    });
  });

  describe('the history of a settlement', () => {
    it('is the single status of a settlement in cash, dated when it was recorded', async () => {
      const cash = await recordCash({ from: linusId, amount: 500 }, adaToken);
      const settlement = await settlementOf(cash.body.id);
      expect(settlement.history).toEqual([{ status: 'paid', at: settlement.at }]);
      expect(settlement.history[0].at).toMatch(AT_PATTERN);
    });

    it('is pending, then paid, for a settlement the provider says succeeded, the earliest first', async () => {
      const settlement = await settlementOf(await graceAsksAda(), graceToken);
      expect(settlement.history).toEqual([{ status: 'pending', at: settlement.at }]);

      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      const paid = await settlementOf(settlement.id, graceToken);
      expect(statusesOf(paid)).toEqual(['pending', 'paid']);
      expect(Date.parse(paid.history[1].at)).toBeGreaterThanOrEqual(Date.parse(paid.history[0].at));
      expect(paid.history[1].at).toMatch(AT_PATTERN);
    });

    it('is pending, then failed, for a settlement the provider says failed', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect(statusesOf(await settlementOf(id, graceToken))).toEqual(['pending', 'failed']);
    });

    it('adds nothing for a webhook that changes nothing', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded', 'wh_again')).status).toBe(204);
      expect((await decide('pay_1', 'pending', 'wh_pending')).status).toBe(204);
      expect((await decide('pay_1', 'failed', 'wh_contrary')).status).toBe(204);
      expect(statusesOf(await settlementOf(id, graceToken))).toEqual(['pending', 'paid']);
    });

    it('adds only the status a webhook moves it to, when it overtakes the ones before', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded', 'wh_late')).status).toBe(204);
      const settlement = await settlementOf(id, graceToken);
      expect(statusesOf(settlement)).toEqual(['pending', 'refunded']);
    });

    it('is refunding, then refunded, for a refund the provider says is done', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await call(app, 'POST', `/settlements/${id}/refund`, { token: adaToken })).status).toBe(204);
      expect(statusesOf(await settlementOf(id, graceToken))).toEqual(['pending', 'paid', 'refunding']);

      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(statusesOf(await settlementOf(id, graceToken))).toEqual(['pending', 'paid', 'refunding', 'refunded']);
    });

    it('goes back to paid, and keeps the refunding it had, when the provider does not take the refund', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      provider.answer = () => ({ status: 500, body: {} });
      expect((await call(app, 'POST', `/settlements/${id}/refund`, { token: adaToken })).status).toBeGreaterThanOrEqual(
        400,
      );
      expect(statusesOf(await settlementOf(id, graceToken))).toEqual(['pending', 'paid', 'refunding', 'paid']);
    });

    it('dates a status by when the webhook came, even when it comes before the provider answers the request', async () => {
      // The provider answers the payment slowly, so its webhook arrives while the request for it is still waiting.
      const answer = provider.answer;
      provider.answer = (request, number) => ({ ...answer(request, number), delayMs: request.body ? 300 : 0 });
      const before = Date.now();
      const asked = askProvider({ to: adaId, amount: 1000 }, graceToken);
      while (provider.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      const after = Date.now();
      const created = await asked;
      expect(created.status).toBe(201);

      const settlement = await settlementOf(created.body.id, graceToken);
      expect(statusesOf(settlement)).toEqual(['pending', 'paid']);
      expect(Date.parse(settlement.history[1].at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(settlement.history[1].at)).toBeLessThanOrEqual(after);
    });

    it('leaves no history for a settlement the provider did not take, as there is none to keep', async () => {
      provider.answer = () => ({ status: 500, body: {} });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBeGreaterThanOrEqual(400);
      const list = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: graceToken });
      expect(list.body).toEqual([]);
    });

    it('is shown on the settlement as well as on the list of the group', async () => {
      const id = await graceAsksAda();
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      const single = await settlementOf(id, graceToken);
      const list = await call(app, 'GET', `/groups/${groupId}/settlements`, { token: graceToken });
      expect(list.body).toEqual([single]);
      expect(single).toMatchObject({ status: 'paid', method: 'provider' });
    });
  });
});
