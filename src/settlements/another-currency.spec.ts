import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  type FakeRatesService,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  startFakeRatesService,
  temporaryDatabaseUrl,
} from '../test-support';

const SECRET = 'shared-secret';

describe('settling up in another currency, at the rate offered on the day', () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;
  let rates: FakeRatesService;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    rates = await startFakeRatesService();
    app = await createApplication({
      databaseUrl,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
      ratesUrl: rates.url,
      ratesTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
    await rates.close();
  });

  let counter = 0;
  /** The provider's signed webhook saying `paymentId` is `status`. */
  function webhookFor(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    return app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': signature },
      payload: body,
    });
  }

  /** The provider's id of the payment made for the settlement `settlementId`. */
  function providerPaymentOf(settlementId: string): string {
    const payment = provider.payments.find(entry => entry.reference === settlementId);
    if (payment === undefined) {
      throw new Error(`no payment was made for ${settlementId}`);
    }
    return payment.id;
  }

  /**
   * Ada owns a EUR group with Grace in it. Grace paid 2000 split between Ada and Grace, so Ada owes Grace 1000.
   * Grace has a payout account at the provider. `on` is the application the group is made in.
   */
  async function adaOwesGrace(on: Application = app) {
    const ada = await signedUpAccount(on);
    const grace = await signedUpAccount(on, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(on, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(on, ada.token, grace.token, groupId);
    await setPayoutAccount(on, grace.token, 'acct-grace');
    const expense = await send(on, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Trip', amount: 2000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  async function balanceOf(token: string, groupId: string, memberId: string): Promise<number> {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>().find(entry => entry.memberId === memberId)!.balance;
  }

  async function settlementsOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/settlements`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>[]>();
  }

  async function readSettlement(token: string, id: string) {
    const response = await send(app, 'GET', `/settlements/${id}`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  /** The audit entries of the group, oldest first. */
  async function auditOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ action: string; subjectId: string; amount: number }[]>();
  }

  /** Grace (the payee) records that Ada paid her `payload.original` in cash. */
  async function settleInCash(
    grace: { token: string },
    groupId: string,
    from: string,
    payload: Record<string, unknown>,
  ) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: grace.token,
      payload: { from, ...payload },
    });
  }

  /** Ada (the payer) pays Grace through the provider. */
  async function payThroughProvider(
    ada: { token: string },
    groupId: string,
    to: string,
    payload: Record<string, unknown>,
  ) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to, ...payload },
    });
  }

  describe('recording a settlement in cash', () => {
    it('takes the rate offered today, converts the amount, and reads the original and the rate back', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.9500');

      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1000 } });
      expect(response.statusCode).toBe(201);
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: todayInUtc() }]);

      const settlement = await readSettlement(ada.token, response.json<{ id: string }>().id);
      // 1000 at 0.95 is 950 in euros, and that is what it settles.
      expect(settlement).toMatchObject({
        from: ada.id,
        to: grace.id,
        amount: 950,
        method: 'cash',
        status: 'paid',
        original: { currency: 'CHF', amount: 1000, rate: '0.9500' },
      });
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-50);
      expect(await balanceOf(grace.token, groupId, grace.id)).toBe(50);
      expect((await settlementsOf(ada.token, groupId))[0]).toMatchObject({
        amount: 950,
        original: { currency: 'CHF' },
      });
    });

    it('rounds the amount to the nearest whole number, a half rounded up, as for an expense', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.5');

      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1001 } });
      expect(response.statusCode).toBe(201);
      // 1001 at 0.5 is 500.5, which is 501.
      expect((await readSettlement(ada.token, response.json<{ id: string }>().id)).amount).toBe(501);
    });

    it('takes the rate offered, whatever rate the payer states with the amount', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.9500');

      const response = await settleInCash(grace, groupId, ada.id, {
        original: { currency: 'CHF', amount: 1000, rate: '0.1' },
      });
      expect(response.statusCode).toBe(201);
      const settlement = await readSettlement(ada.token, response.json<{ id: string }>().id);
      expect(settlement).toMatchObject({ amount: 950, original: { rate: '0.9500' } });
    });

    it('reads a settlement in the group’s currency with no original', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();

      const response = await settleInCash(grace, groupId, ada.id, { amount: 400 });
      expect(response.statusCode).toBe(201);
      const settlement = await readSettlement(ada.token, response.json<{ id: string }>().id);
      expect(settlement.amount).toBe(400);
      expect(settlement).not.toHaveProperty('original');
      expect(rates.requests).toEqual([]);
    });

    it('audits the amount in the group’s currency', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1000 } });
      const entries = await auditOf(ada.token, groupId);
      expect(entries.at(-1)).toMatchObject({
        action: 'settlement-paid',
        subjectId: response.json<{ id: string }>().id,
        amount: 950,
      });
    });

    it.each([
      ['refuses', 'refuse'],
      ['answers a rate that is not text', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('is refused with 409, and kept nothing, when the rates service %s', async (_, mode) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
      rates.mode = mode;

      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1000 } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'NoRateOffered' });
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-1000);
    });

    it('is refused with 409 when no rate is offered for today', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', '2026-11-18', '0.95');

      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1000 } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'NoRateOffered' });
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
    });

    it('is refused with 409 on a server started without a rates service', async () => {
      const without = await createApplication({
        databaseUrl: await temporaryDatabaseUrl(),
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      try {
        const { ada, grace, groupId } = await adaOwesGrace(without);
        const response = await send(without, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: grace.token,
          payload: { from: ada.id, original: { currency: 'CHF', amount: 1000 } },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ type: 'NoRateOffered' });
      } finally {
        await without.stop();
      }
    });

    it.each([
      ['neither an amount nor an original', {}],
      ['both an amount and an original', { amount: 400, original: { currency: 'CHF', amount: 1000 } }],
    ])('is refused with 400, as the wrong shape, with %s', async (_, payload) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

      const response = await settleInCash(grace, groupId, ada.id, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ type: 'InvalidBody' });
      expect(rates.requests).toEqual([]);
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
    });

    it.each([
      ['the group’s own currency', { currency: 'EUR', amount: 1000 }, 'InvalidOriginalCurrency'],
      ['a currency Tally does not have', { currency: 'JPY', amount: 1000 }, 'InvalidOriginalCurrency'],
      ['an amount of nothing', { currency: 'CHF', amount: 0 }, 'InvalidOriginalAmount'],
      ['an amount that is not whole', { currency: 'CHF', amount: 10.5 }, 'InvalidOriginalAmount'],
      ['an amount above 100 000 000', { currency: 'CHF', amount: 100_000_001 }, 'InvalidOriginalAmount'],
    ])('is refused with 422, and asks nothing, for %s', async (_, original, type) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

      const response = await settleInCash(grace, groupId, ada.id, { original });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ type });
      expect(rates.requests).toEqual([]);
    });

    it('is refused with 422 when the amount in the group’s currency rounds to nothing', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.4');

      // 1 at 0.4 is 0.4, which is 0 in euros: a settlement is at least 1.
      const response = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1 } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ type: 'InvalidAmount' });
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
    });

    it('is refused with 409 when, once converted, it is more than is owed, and recorded when it is not', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '1');

      const over = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1001 } });
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ type: 'MoreThanIsOwed' });
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);

      const exact = await settleInCash(grace, groupId, ada.id, { original: { currency: 'CHF', amount: 1000 } });
      expect(exact.statusCode).toBe(201);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(0);
    });
  });

  describe('paying through the provider', () => {
    it('asks the provider for the payment in the currency paid, and keeps the settlement at the rate decided', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.9500');

      const response = await payThroughProvider(ada, groupId, grace.id, {
        original: { currency: 'CHF', amount: 1000 },
      });
      expect(response.statusCode).toBe(201);
      const id = response.json<{ id: string }>().id;
      expect(provider.requests).toEqual([{ reference: id, amount: 1000, currency: 'CHF', payee: 'acct-grace' }]);

      expect(await readSettlement(ada.token, id)).toMatchObject({
        status: 'pending',
        method: 'provider',
        amount: 950,
        original: { currency: 'CHF', amount: 1000, rate: '0.9500' },
        fee: { amount: 0, borneBy: 'payee' },
      });
    });

    it('reads a settlement in the group’s currency through the provider with no original', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();

      const response = await payThroughProvider(ada, groupId, grace.id, { amount: 400 });
      const settlement = await readSettlement(ada.token, response.json<{ id: string }>().id);
      expect(settlement).not.toHaveProperty('original');
      expect(provider.requests[0]).toMatchObject({ amount: 400, currency: 'EUR' });
    });

    it.each([
      ['payee bears it', 'payee', 950, 95],
      ['payer bears it', 'payer', 855, 95],
      ['both share it, half rounded down', 'shared', 903, 95],
    ])(
      'converts the provider’s fee at the rate, and settles the amount less what the payer bears when the %s',
      async (_, borneBy, settled, fee) => {
        const { ada, grace, groupId } = await adaOwesGrace();
        const policy = await send(app, 'PUT', `/groups/${groupId}/fee-policy`, {
          token: ada.token,
          payload: { borneBy },
        });
        expect(policy.statusCode).toBe(204);
        rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
        // The provider's fee is 100 Swiss francs: 95 in euros at the settlement's rate.
        provider.fee = 100;

        const response = await payThroughProvider(ada, groupId, grace.id, {
          original: { currency: 'CHF', amount: 1000 },
        });
        expect(response.statusCode).toBe(201);
        const id = response.json<{ id: string }>().id;
        expect((await readSettlement(ada.token, id)).fee).toEqual({ amount: fee, borneBy });

        expect((await webhookFor(providerPaymentOf(id), 'succeeded')).statusCode).toBe(204);
        const audit = await auditOf(ada.token, groupId);
        expect(audit.at(-1)).toMatchObject({ action: 'settlement-paid', subjectId: id, amount: settled });
      },
    );

    it('is refused with 409, and keeps nothing, when the fee once converted is not below the amount in the group’s currency', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      // 3 Swiss francs at 0.4 is 1.2, which is 1 in euros; a fee of 2 francs is 0.8, which is 1 too: not below the amount.
      rates.offer('CHF', 'EUR', todayInUtc(), '0.4');
      provider.fee = 2;

      const response = await payThroughProvider(ada, groupId, grace.id, { original: { currency: 'CHF', amount: 3 } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'PaymentNotStarted' });
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-1000);
    });

    it('is refused with 409, and asks nothing of the provider, when no rate is offered for today', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();

      const response = await payThroughProvider(ada, groupId, grace.id, {
        original: { currency: 'CHF', amount: 1000 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'NoRateOffered' });
      expect(provider.requests).toEqual([]);
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
    });

    it.each([
      ['refuses', 'refuse'],
      ['answers a rate that is not text', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('is refused with 409, and asks nothing of the provider, when the rates service %s', async (_, mode) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
      rates.mode = mode;

      const response = await payThroughProvider(ada, groupId, grace.id, {
        original: { currency: 'CHF', amount: 1000 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'NoRateOffered' });
      expect(provider.requests).toEqual([]);
      expect(await settlementsOf(ada.token, groupId)).toEqual([]);
    });

    it('keeps the rate decided, and counts the amount decided, whatever the rates service says later, paid or refunded', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.9500');

      const response = await payThroughProvider(ada, groupId, grace.id, {
        original: { currency: 'CHF', amount: 1000 },
      });
      const id = response.json<{ id: string }>().id;
      // The rate moves after the settlement is decided: its payment, and its refund, keep the rate decided.
      rates.offer('CHF', 'EUR', todayInUtc(), '0.80');

      expect((await webhookFor(providerPaymentOf(id), 'succeeded')).statusCode).toBe(204);
      expect(await readSettlement(ada.token, id)).toMatchObject({
        status: 'paid',
        amount: 950,
        original: { currency: 'CHF', amount: 1000, rate: '0.9500' },
      });

      const refund = await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token });
      expect(refund.statusCode).toBe(204);
      expect((await webhookFor(providerPaymentOf(id), 'refunded')).statusCode).toBe(204);

      const audit = (await auditOf(ada.token, groupId)).filter(entry => entry.subjectId === id);
      expect(audit.map(entry => [entry.action, entry.amount])).toEqual([
        ['settlement-paid', 950],
        ['settlement-refunded', 950],
      ]);
      expect(await readSettlement(ada.token, id)).toMatchObject({
        status: 'refunded',
        amount: 950,
        original: { rate: '0.9500' },
      });
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-1000);
    });
  });
});
