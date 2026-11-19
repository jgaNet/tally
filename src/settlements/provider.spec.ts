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

describe('paying through the provider', () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({ databaseUrl, providerUrl: provider.url, providerTimeoutMs: 300 });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  async function createdGroup(token: string, currency = 'EUR'): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function payThroughProvider(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, { token, payload });
  }

  async function settleInCash(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token, payload });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  /**
   * Ada owns a group with Grace and Linus in it, in that order. Grace paid 1000 split between Ada and
   * Grace, so Ada owes Grace 500: Ada's balance is -500, Grace's 500, Linus's 0. Grace's payout account
   * is `acct-grace`, unless `graceSetsPayoutAccount` is false.
   */
  async function adaOwesGrace({ graceSetsPayoutAccount = true } = {}) {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    if (graceSetsPayoutAccount) {
      await setPayoutAccount(app, grace.token, 'acct-grace');
    }
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, linus, groupId };
  }

  describe('asking for a payment', () => {
    it('asks the provider for a payment of the amount, in the group’s currency, referenced by the settlement', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
      expect(provider.requests).toEqual([
        { reference: response.json().id, amount: 300, currency: 'EUR', payee: 'acct-grace' },
      ]);
    });

    it('answers the settlement as pending, through the provider, with the link where the payer pays', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = (await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 })).json().id;
      const read = await send(app, 'GET', `/settlements/${id}`, { token: grace.token });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        id,
        groupId,
        from: ada.id,
        to: grace.id,
        amount: 300,
        method: 'provider',
        status: 'pending',
        payUrl: provider.payments[0].payUrl,
        fee: { amount: 0, borneBy: 'payee' },
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/),
        history: [{ status: 'pending', at: expect.any(String) }],
      });
    });

    it('leaves the balances as they were until the provider says the payment succeeded', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-500);
    });

    it('refuses a payer who owes nothing with 409, as a cash settlement would', async () => {
      const { grace, ada, groupId } = await adaOwesGrace();
      // Grace is owed by Ada, so she owes nothing: she cannot pay Ada through the provider.
      const response = await payThroughProvider(grace.token, groupId, { to: ada.id, amount: 100 });
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('MoreThanIsOwed');
      expect(provider.requests).toHaveLength(0);
    });

    it('answers 401 to a request with no token, and 404 to a person who is not a member', async () => {
      const { grace, groupId } = await adaOwesGrace();
      const payload = { to: grace.id, amount: 300 };
      expect((await send(app, 'POST', `/groups/${groupId}/settlements/provider`, { payload })).statusCode).toBe(401);
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const outsider = await payThroughProvider(eve.token, groupId, payload);
      const missing = await payThroughProvider(eve.token, 'no-such-group', payload);
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
      expect(provider.requests).toHaveLength(0);
    });

    it('refuses a payee who is not a member as not there, and a payee who is the payer with 422', async () => {
      const { ada, groupId } = await adaOwesGrace();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      expect((await payThroughProvider(ada.token, groupId, { to: eve.id, amount: 100 })).statusCode).toBe(404);
      const self = await payThroughProvider(ada.token, groupId, { to: ada.id, amount: 100 });
      expect(self.statusCode).toBe(422);
      expect(self.json().type).toBe('SettlementToSelf');
    });

    it('refuses an amount that is not a whole number at least 1 with 422, and a string with 400', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      for (const amount of [0, -5, 1.5]) {
        const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount });
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidAmount');
      }
      expect((await payThroughProvider(ada.token, groupId, { to: grace.id, amount: '300' })).statusCode).toBe(400);
    });

    it('refuses more than the payer owes, or than the payee is owed, with 409 and asks nothing of the provider', async () => {
      const { ada, grace, linus, groupId } = await adaOwesGrace();
      const more = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 501 });
      expect(more.statusCode).toBe(409);
      expect(more.json().type).toBe('MoreThanIsOwed');
      // Linus is owed nothing, so Ada cannot pay him.
      expect((await payThroughProvider(ada.token, groupId, { to: linus.id, amount: 1 })).json().type).toBe(
        'MoreThanIsOwed',
      );
      expect(provider.requests).toHaveLength(0);
    });

    it('refuses when the provider is not set up on this server, and keeps nothing', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await app.stop();
      app = await createApplication({ databaseUrl });
      const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('ProviderNotConfigured');
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-500);
    });
  });

  describe('the payee’s payout account', () => {
    it('is the account the provider is told the payment goes to, as it is when the payment is asked', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const first = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 100 });
      expect(first.statusCode).toBe(201);
      await setPayoutAccount(app, grace.token, 'acct-grace-2');
      const second = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 100 });
      expect(second.statusCode).toBe(201);
      expect(provider.requests.map(request => request.payee)).toEqual(['acct-grace', 'acct-grace-2']);
      // The payment asked for before goes on as it was: still pending, at the same link.
      const earlier = await send(app, 'GET', `/settlements/${first.json().id}`, { token: ada.token });
      expect(earlier.json()).toEqual(
        expect.objectContaining({ status: 'pending', payUrl: provider.payments[0].payUrl }),
      );
    });

    it('refuses a payee with no payout account with 409, by the name of the rule, and asks the provider nothing', async () => {
      const { ada, grace, groupId } = await adaOwesGrace({ graceSetsPayoutAccount: false });
      const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'NoPayoutAccount', message: expect.any(String) });
      expect(provider.requests).toHaveLength(0);
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-500);
      // Nothing is held: the same payment is refused the same way, and cash still settles it.
      expect((await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 })).json().type).toBe(
        'NoPayoutAccount',
      );
      expect((await settleInCash(grace.token, groupId, { from: ada.id, amount: 500 })).statusCode).toBe(201);
    });

    it('is checked after the rules of a cash settlement, so an amount owed is still refused as such', async () => {
      const { ada, grace, groupId } = await adaOwesGrace({ graceSetsPayoutAccount: false });
      const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 501 });
      expect(response.json().type).toBe('MoreThanIsOwed');
    });
  });

  describe('when the provider does not start a payment', () => {
    it.each([
      ['answers with something other than 201', 'refuse'],
      ['answers 201 without an id and a payUrl', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('refuses with 409 when it %s, and keeps nothing', async (_, mode) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      provider.mode = mode;
      const response = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 500 });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'PaymentNotStarted', message: expect.any(String) });
      expect((await balancesOf(ada.token, groupId))[0].balance).toBe(-500);

      // Nothing is held: the whole amount can still be paid, in cash, at once.
      provider.mode = 'accept';
      expect((await settleInCash(grace.token, groupId, { from: ada.id, amount: 500 })).statusCode).toBe(201);
    });
  });

  describe('what is waiting at the provider', () => {
    it('counts as paid for what is still owed: a second payment and a cash settlement cannot pay it again', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      expect((await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 })).statusCode).toBe(201);
      // Ada still owes 200 as far as her payments go.
      const again = await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      expect(again.statusCode).toBe(409);
      expect(again.json().type).toBe('MoreThanIsOwed');
      expect((await settleInCash(grace.token, groupId, { from: ada.id, amount: 300 })).statusCode).toBe(409);
      expect((await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 200 })).statusCode).toBe(201);
    });

    it('is counted in the suggested settlements, as what is still owed', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await payThroughProvider(ada.token, groupId, { to: grace.id, amount: 300 });
      const suggested = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ada.token });
      expect(suggested.json()).toEqual([{ from: ada.id, to: grace.id, amount: 200 }]);
    });

    it('keeps a member from leaving while a payment involving them waits, even at a balance of 0', async () => {
      // Linus, a plain member, owes Grace 300 for a taxi she paid and they split.
      const { grace, linus, groupId } = await adaOwesGrace();
      const taxi = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: grace.token,
        payload: { description: 'Taxi', amount: 600, date: todayInUtc(), splitBetween: [grace.id, linus.id] },
      });
      expect(taxi.statusCode).toBe(201);
      expect((await payThroughProvider(linus.token, groupId, { to: grace.id, amount: 300 })).statusCode).toBe(201);
      // A new fare Linus paid, split with Grace, brings his balance to 0 while the payment waits.
      const fare = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: linus.token,
        payload: { description: 'Bus', amount: 600, date: todayInUtc(), splitBetween: [grace.id, linus.id] },
      });
      expect(fare.statusCode).toBe(201);
      expect((await balancesOf(linus.token, groupId)).find(b => b.memberId === linus.id)?.balance).toBe(0);
      const leave = await send(app, 'POST', `/groups/${groupId}/leave`, { token: linus.token });
      expect(leave.statusCode).toBe(409);
      expect(leave.json().type).toBe('PaymentPending');
    });
  });
});
