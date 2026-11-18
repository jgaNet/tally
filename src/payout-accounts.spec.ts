import { createHmac } from 'node:crypto';
import { Application } from './app';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };

const PAST_DAY = '2026-11-01';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

describe('payout accounts', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  const setPayoutAccount = (accountId: string, token: string, using: Application = app) =>
    call(using, 'PUT', '/accounts/me/payout-account', { body: { accountId }, token });

  const readPayoutAccount = (token: string, using: Application = app) =>
    call(using, 'GET', '/accounts/me/payout-account', { token });

  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const balancesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  /** The webhook body as the provider sends it, and its signature. */
  function decide(paymentId: string, status: string) {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken })).status).toBe(
      204,
    );
    // Ada paid 2000, split equally: Ada is owed 1000, Grace owes 1000.
    const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Dinner',
        amount: 2000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 1000 },
          { memberId: graceId, amount: 1000 },
        ],
      },
      token: adaToken,
    });
    expect(expense.status).toBe(201);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('setting and reading a payout account', () => {
    it('sets the payout account, which the member then reads back', async () => {
      const set = await setPayoutAccount('acct_ada', adaToken);
      expect(set.status).toBe(204);
      expect(await readPayoutAccount(adaToken)).toEqual({ status: 200, body: { accountId: 'acct_ada' } });
    });

    it('asks the provider whether it knows the account, on its accounts path', async () => {
      await setPayoutAccount('acct_ada', adaToken);
      expect(provider.requests).toEqual([{ path: '/accounts/acct_ada' }]);
    });

    it('answers 404 to a member who has no payout account', async () => {
      expect(await readPayoutAccount(adaToken)).toEqual({
        status: 404,
        body: { type: 'NotFound', message: expect.any(String) },
      });
    });

    it('refuses an account the provider does not know, and keeps the one the member had', async () => {
      expect((await setPayoutAccount('acct_ada', adaToken)).status).toBe(204);
      provider.answer = () => ({ status: 404, body: { type: 'NotFound' } });
      const answer = await setPayoutAccount('acct_unknown', adaToken);
      expect(answer).toEqual({
        status: 422,
        body: { type: 'UnknownPayoutAccount', message: expect.any(String) },
      });
      expect((await readPayoutAccount(adaToken)).body).toEqual({ accountId: 'acct_ada' });
    });

    it.each([
      ['a failure', { status: 500, raw: 'oops' }],
      ['an answer that is not 200', { status: 201, body: { id: 'acct_ada' } }],
      ['an answer about another account', { status: 200, body: { id: 'acct_other' } }],
      ['an answer without an id', { status: 200, body: {} }],
      ['an answer that is not JSON', { status: 200, raw: '<html>known</html>' }],
    ])('refuses the account when the provider answers with %s, and keeps the one the member had', async (_, answer) => {
      expect((await setPayoutAccount('acct_ada', adaToken)).status).toBe(204);
      provider.answer = () => answer;
      const refused = await setPayoutAccount('acct_new', adaToken);
      expect(refused).toEqual({ status: 424, body: { type: 'ProviderUnavailable', message: expect.any(String) } });
      expect((await readPayoutAccount(adaToken)).body).toEqual({ accountId: 'acct_ada' });
    });

    it('refuses the account when the provider does not answer within the time allowed', async () => {
      await app.stop();
      app = await startApplication(database.url, {
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
        providerTimeoutMs: 150,
      });
      provider.answer = () => ({ status: 200, body: { id: 'acct_slow' }, delayMs: 2000 });
      expect((await setPayoutAccount('acct_slow', adaToken)).status).toBe(424);
      expect((await readPayoutAccount(adaToken)).status).toBe(404);
    });

    it('refuses the account when the provider cannot be reached', async () => {
      const gone = await startFakeProvider();
      const url = gone.url;
      await gone.stop();
      await app.stop();
      app = await startApplication(database.url, { providerUrl: url, providerWebhookSecret: SECRET });
      expect((await setPayoutAccount('acct_ada', adaToken)).status).toBe(424);
    });

    it('refuses the account, and asks nothing, when the provider is not configured', async () => {
      const unconfigured = await startApplication(database.url, { providerUrl: '' });
      extraApps.push(unconfigured);
      const answer = await setPayoutAccount('acct_ada', adaToken, unconfigured);
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('ProviderNotConfigured');
      expect(provider.requests).toEqual([]);
    });

    it('replaces the payout account the member had with the next one set', async () => {
      await setPayoutAccount('acct_one', adaToken);
      await setPayoutAccount('acct_two', adaToken);
      expect((await readPayoutAccount(adaToken)).body).toEqual({ accountId: 'acct_two' });
    });

    it('lets each member set and read only their own payout account', async () => {
      await setPayoutAccount('acct_ada', adaToken);
      expect((await readPayoutAccount(graceToken)).status).toBe(404);
      await setPayoutAccount('acct_grace', graceToken);
      expect((await readPayoutAccount(adaToken)).body).toEqual({ accountId: 'acct_ada' });
      expect((await readPayoutAccount(graceToken)).body).toEqual({ accountId: 'acct_grace' });
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      expect((await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: 'acct_ada' } })).status).toBe(
        401,
      );
      expect((await call(app, 'GET', '/accounts/me/payout-account')).status).toBe(401);
      expect((await setPayoutAccount('acct_ada', 'not-a-token')).status).toBe(401);
    });

    it('refuses an account that is not a non-empty text', async () => {
      const answer = await call(app, 'PUT', '/accounts/me/payout-account', {
        body: { accountId: '' },
        token: adaToken,
      });
      expect(answer.status).toBe(400);
      expect(provider.requests).toEqual([]);
    });
  });

  describe('a member is paid through the provider only with a payout account', () => {
    it('refuses to ask a provider payment to a member with no payout account, by the name of the rule, and asks nothing', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer).toEqual({
        status: 409,
        body: { type: 'PayoutAccountRequired', message: expect.any(String) },
      });
      expect(provider.requests).toEqual([]);
      // Nothing is held: Grace still owes 1000, and the suggested transfer is still the whole of it.
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: -1000 });
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      expect(suggested.body).toEqual([{ from: graceId, to: adaId, amount: 1000 }]);
    });

    it('asks the provider for the payment to the payee payout account, as it is set', async () => {
      await setPayoutAccount('acct_ada', adaToken);
      provider.requests.splice(0);
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer.status).toBe(201);
      expect(provider.requests).toEqual([
        {
          path: '/payments',
          body: { reference: answer.body.id, amount: 1000, currency: 'EUR', payee: 'acct_ada' },
        },
      ]);
    });

    it('asks with the payout account the payee has when the payment is asked, after a replacement', async () => {
      await setPayoutAccount('acct_one', adaToken);
      await setPayoutAccount('acct_two', adaToken);
      provider.requests.splice(0);
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(201);
      expect(provider.requests[0].body?.payee).toBe('acct_two');
    });

    it('lets a payment asked before the payout account is replaced go on as it was', async () => {
      await setPayoutAccount('acct_ada', adaToken);
      provider.requests.splice(0);
      const { id } = (await askProvider({ to: adaId, amount: 1000 }, graceToken)).body;
      await setPayoutAccount('acct_replacement', adaToken);
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await call(app, 'GET', `/settlements/${id}`, { token: graceToken })).body).toMatchObject({
        method: 'provider',
        status: 'paid',
      });
      expect(await balancesOf()).toEqual({ [adaId]: 0, [graceId]: 0 });
    });

    it('settles in cash to a member with no payout account, which needs none', async () => {
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, amount: 1000 },
        token: adaToken,
      });
      expect(answer.status).toBe(201);
      expect(await balancesOf()).toEqual({ [adaId]: 0, [graceId]: 0 });
    });
  });
});
