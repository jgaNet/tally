import { Application } from './app';
import { readRows } from './test-support';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
// The provider's id of Ada's payout account.
const adaPayout = 'acct_ada';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('paying through the payment provider: asking for a payment', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderId: string;
  let outsiderToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner, and accepts it. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Asks to pay the payee through the provider, by the account that signs the request with `token`. */
  const askProvider = (body: unknown, token: string, using: Application = app) =>
    call(using, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const balancesOf = async (token = adaToken): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  /** The rows of the settlements table, read apart from the application, as the file keeps them. */
  const settlementRows = (): Promise<Array<Record<string, unknown>>> =>
    readRows(database.url, 'SELECT * FROM settlements');

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: 'whsec_test' });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    // Ada is paid through the provider, on her payout account. Setting it asks the provider, which is not a payment.
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ id: outsiderId, token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
    // Ada paid 3000, split equally between the three: Ada is owed 2000, Grace and Linus each owe 1000.
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
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('asking for a payment', () => {
    it('asks the provider for a payment of the amount, in the currency of the group, with the settlement as its reference', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer.status).toBe(201);
      expect(answer.body).toEqual({ id: expect.any(String) });
      expect(provider.requests).toEqual([
        { path: '/payments', body: { reference: answer.body.id, amount: 1000, currency: 'EUR', payee: adaPayout } },
      ]);
    });

    it('keeps the settlement pending, with the link where the payer pays it, and counts it as not paid yet', async () => {
      const { id } = (await askProvider({ to: adaId, amount: 1000 }, graceToken)).body;
      const read = await call(app, 'GET', `/settlements/${id}`, { token: graceToken });
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        id,
        groupId,
        from: graceId,
        to: adaId,
        amount: 1000,
        method: 'provider',
        status: 'pending',
        at: expect.stringMatching(AT_PATTERN),
        payUrl: 'https://pay.example/pay_1',
        history: [{ status: 'pending', at: expect.stringMatching(AT_PATTERN) }],
      });
      // Not yet paid: the balances are as they were.
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('lets the payee read the settlement too, and answers its payment link to the members only', async () => {
      const { id } = (await askProvider({ to: adaId, amount: 1000 }, graceToken)).body;
      expect((await call(app, 'GET', `/settlements/${id}`, { token: adaToken })).body.payUrl).toBe(
        'https://pay.example/pay_1',
      );
      expect((await call(app, 'GET', `/settlements/${id}`, { token: outsiderToken })).status).toBe(404);
    });

    it('counts a payment waiting at the provider as paid for what the payer still owes', async () => {
      await askProvider({ to: adaId, amount: 1000 }, graceToken);
      // Grace owes 1000, and 1000 is waiting to be paid: nothing more is owed by Grace.
      const again = await askProvider({ to: adaId, amount: 1 }, graceToken);
      expect(again.status).toBe(409);
      expect(again.body.type).toBe('AmountTooLarge');
      expect(provider.requests).toHaveLength(1);
    });

    it('counts a payment waiting at the provider as paid for what the payee is still owed', async () => {
      await askProvider({ to: adaId, amount: 1000 }, graceToken);
      // Ada is owed 2000, 1000 of which is waiting to be paid to her: 1000 is still owed to her.
      expect((await askProvider({ to: adaId, amount: 1001 }, linusToken)).status).toBe(409);
      expect((await askProvider({ to: adaId, amount: 1000 }, linusToken)).status).toBe(201);
    });

    it('refuses more than the payer owes, and keeps nothing', async () => {
      const answer = await askProvider({ to: adaId, amount: 1001 }, graceToken);
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('AmountTooLarge');
      expect(provider.requests).toHaveLength(0);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('refuses an amount that is not a whole number of at least 1, and keeps nothing', async () => {
      expect((await askProvider({ to: adaId, amount: 0 }, graceToken)).status).toBe(422);
      expect((await askProvider({ to: adaId, amount: -5 }, graceToken)).status).toBe(422);
      expect((await askProvider({ to: adaId, amount: 1.5 }, graceToken)).status).toBeGreaterThanOrEqual(400);
      expect(provider.requests).toHaveLength(0);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('refuses a payee who is the payer, or who is not a member of the group, and keeps nothing', async () => {
      const toSelf = await askProvider({ to: graceId, amount: 500 }, graceToken);
      expect(toSelf.status).toBe(422);
      expect(toSelf.body.type).toBe('InvalidPayee');
      const toOutsider = await askProvider({ to: outsiderId, amount: 500 }, graceToken);
      expect(toOutsider.status).toBe(422);
      expect(toOutsider.body.type).toBe('InvalidPayee');
      expect(provider.requests).toHaveLength(0);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('answers 404 to an account outside the group, and for a group that does not exist', async () => {
      const outside = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: outsiderToken,
      });
      expect(outside.status).toBe(404);
      const missing = await call(app, 'POST', '/groups/no-such-group/settlements/provider', {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect(missing.status).toBe(404);
      expect(provider.requests).toHaveLength(0);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      expect(
        (await call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body: { to: adaId, amount: 1 } })).status,
      ).toBe(401);
      expect((await askProvider({ to: adaId, amount: 1000 }, 'not-a-token')).status).toBe(401);
    });

    it('decides two payments asked at once on the balances as the other left them', async () => {
      const [first, second] = await Promise.all([
        askProvider({ to: adaId, amount: 800 }, graceToken),
        askProvider({ to: adaId, amount: 800 }, graceToken),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(provider.requests).toHaveLength(1);
      expect(await settlementRows()).toHaveLength(1);
    });
  });

  describe('what a settlement in cash counts', () => {
    it('counts a payment waiting at the provider as paid, for a settlement in cash too', async () => {
      await askProvider({ to: adaId, amount: 1000 }, graceToken);
      // Grace owes nothing more once the 1000 is waiting; Ada is still owed 1000 by the group.
      const tooMuch = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, amount: 1 },
        token: adaToken,
      });
      expect(tooMuch.status).toBe(409);
      expect(tooMuch.body.type).toBe('AmountTooLarge');
      const fromLinus = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: linusId, amount: 1000 },
        token: adaToken,
      });
      expect(fromLinus.status).toBe(201);
      // Nothing is left for Ada to be paid, and nothing is counted in the balances before it is paid.
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: -1000, [linusId]: 0 });
    });
  });

  describe('when the provider does not answer a payment', () => {
    it('refuses the request, and keeps nothing, when the provider is not configured', async () => {
      const unconfigured = await startApplication(database.url, { providerUrl: '' });
      extraApps.push(unconfigured);
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken, unconfigured);
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('ProviderNotConfigured');
      expect(await settlementRows()).toHaveLength(0);
      expect(provider.requests).toHaveLength(0);
    });

    it('refuses the request, and keeps nothing, when the provider answers other than 201', async () => {
      provider.answer = () => ({ status: 200, body: { id: 'pay_x', payUrl: 'https://pay.example/x' } });
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer.status).toBe(424);
      expect(answer.body.type).toBe('ProviderUnavailable');
      expect(await settlementRows()).toHaveLength(0);
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('refuses the request, and keeps nothing, when the provider fails', async () => {
      provider.answer = () => ({ status: 500, raw: 'oops' });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(424);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('refuses the request, and keeps nothing, when the provider answers without a payment link', async () => {
      provider.answer = () => ({ status: 201, body: { id: 'pay_x' } });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(424);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('refuses the request, and keeps nothing, when the provider answers with a body that is not JSON', async () => {
      provider.answer = () => ({ status: 201, raw: '<html>created</html>' });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(424);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('refuses the request, and keeps nothing, when the provider does not answer within the time allowed', async () => {
      await app.stop();
      app = await startApplication(database.url, {
        providerUrl: provider.url,
        providerWebhookSecret: 'whsec_test',
        providerTimeoutMs: 150,
      });
      provider.answer = () => ({
        status: 201,
        body: { id: 'pay_slow', payUrl: 'https://pay.example/slow' },
        delayMs: 2000,
      });
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer.status).toBe(424);
      expect(await settlementRows()).toHaveLength(0);
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('refuses the request, and keeps nothing, when the provider cannot be reached', async () => {
      const gone = await startFakeProvider();
      const url = gone.url;
      await gone.stop();
      await app.stop();
      app = await startApplication(database.url, { providerUrl: url, providerWebhookSecret: 'whsec_test' });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(424);
      expect(await settlementRows()).toHaveLength(0);
    });

    it('asks again once the provider is answering again, and then keeps the settlement', async () => {
      provider.answer = () => ({ status: 500, raw: 'oops' });
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(424);
      provider.answer = (_request, number) => ({
        status: 201,
        body: { id: `pay_${number}`, payUrl: 'https://pay.example/ok' },
      });
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(answer.status).toBe(201);
      expect((await call(app, 'GET', `/settlements/${answer.body.id}`, { token: graceToken })).body).toMatchObject({
        method: 'provider',
        status: 'pending',
        payUrl: 'https://pay.example/ok',
      });
    });
  });
});
