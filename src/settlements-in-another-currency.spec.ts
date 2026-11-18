import { createHmac } from 'node:crypto';
import { Application } from './app';
import { todayUtc } from './days';
import {
  ada,
  call,
  countRows,
  FakeProvider,
  FakeRates,
  startApplication,
  startFakeProvider,
  startFakeRates,
  temporaryDatabase,
} from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
// The provider's id of Ada's payout account.
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('settling in another currency', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let rates: FakeRates;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let outsiderToken: string;
  let groupId: string;
  let webhooks = 0;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** The rates service offers `rate` for every request. */
  const offers = (rate: string) => {
    rates.answer = () => ({ status: 200, body: { rate } });
  };

  /** Sends the provider's webhook for a payment, signed as the provider signs it. */
  function sendWebhook(paymentId: string, status: string) {
    webhooks += 1;
    const raw = JSON.stringify({ id: `wh_${webhooks}`, paymentId, status, at: '2026-11-20T10:00:00Z' });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  }

  const settleInCash = (body: unknown, token = adaToken) =>
    call(app, 'POST', `/groups/${groupId}/settlements/cash`, { body, token });

  const askProvider = (body: unknown, token = graceToken) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const readSettlement = (id: string, token = adaToken) => call(app, 'GET', `/settlements/${id}`, { token });

  const balancesOf = async (token = adaToken): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    rates = await startFakeRates();
    app = await startApplication(database.url, {
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      ratesUrl: rates.url,
      ratesTimeoutMs: 300,
    });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The trip', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken })).status).toBe(
      204,
    );
    // Ada paid 10 000, split equally: Grace owes Ada 5 000 euros.
    const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Trip',
        amount: 10000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 5000 },
          { memberId: graceId, amount: 5000 },
        ],
      },
      token: adaToken,
    });
    expect(expense.status).toBe(201);
    // Swiss francs are offered at 0.9250 euros each, for every day asked for, unless a test says otherwise.
    offers('0.9250');
    provider.requests.splice(0);
    rates.requests.splice(0);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await rates.stop();
    await database.remove();
  });

  describe('recorded in cash', () => {
    it('records the amount in the group’s currency, at the rate offered today, and keeps the original and the rate', async () => {
      // 54.00 francs at 0.9250 is 49.95 euros.
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      expect(answer.status).toBe(201);
      const read = await readSettlement(answer.body.id);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        id: answer.body.id,
        groupId,
        from: graceId,
        to: adaId,
        amount: 4995,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(AT_PATTERN),
        original: { currency: 'CHF', amount: 5400, rate: '0.9250' },
        history: [{ status: 'paid', at: expect.stringMatching(AT_PATTERN) }],
      });
    });

    it('asks the rates service for the rate from the currency to the group’s, on today in UTC, and nothing more', async () => {
      await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: todayUtc() }]);
    });

    it('counts the converted amount in the balances, and in the audit', async () => {
      await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      expect(await balancesOf()).toEqual({ [adaId]: 5, [graceId]: -5 });
      const audit = await call(app, 'GET', `/groups/${groupId}/audit`, { token: adaToken });
      expect(audit.body.at(-1)).toMatchObject({ action: 'settlement-paid', by: adaId, amount: 4995 });
    });

    it('converts to the nearest whole number, a half rounded up', async () => {
      // 0.5 rounds up to 1; 4.5 rounds up to 5; 4.4 rounds down to 4.
      offers('0.5');
      expect((await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 1 } })).body).toEqual({
        id: expect.any(String),
      });
      offers('1.5');
      const three = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 3 } });
      expect((await readSettlement(three.body.id)).body).toMatchObject({ amount: 5 });
      offers('1.4667');
      const three2 = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 3 } });
      expect((await readSettlement(three2.body.id)).body).toMatchObject({ amount: 4 });
    });

    it('keeps the rate the rates service wrote, as it wrote it', async () => {
      offers('0.90');
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 1000 } });
      expect((await readSettlement(answer.body.id)).body).toMatchObject({
        amount: 900,
        original: { currency: 'CHF', amount: 1000, rate: '0.90' },
      });
    });

    it('takes the rate offered whatever rate the payer gives, which the payer does not give', async () => {
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400, rate: '9' } });
      expect(answer.status).toBe(201);
      expect((await readSettlement(answer.body.id)).body).toMatchObject({
        amount: 4995,
        original: { rate: '0.9250' },
      });
    });

    it('keeps the rate and the amount as they were decided, whatever the rates service says later', async () => {
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      offers('0.5');
      expect((await readSettlement(answer.body.id)).body).toMatchObject({
        amount: 4995,
        original: { amount: 5400, rate: '0.9250' },
      });
      expect(await balancesOf()).toEqual({ [adaId]: 5, [graceId]: -5 });
    });

    it('reads a settlement in the group’s currency without an original', async () => {
      const answer = await settleInCash({ from: graceId, amount: 1000 });
      const read = await readSettlement(answer.body.id);
      expect(read.body).not.toHaveProperty('original');
      expect(read.body).toMatchObject({ amount: 1000, method: 'cash' });
    });

    it('is refused, with nothing kept, when no rate is offered, and the rates service is asked for it', async () => {
      rates.answer = () => ({ status: 404 });
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('NoRateOffered');
      expect(rates.requests).toHaveLength(1);
      expect(await countRows(database.url, 'settlements')).toBe(0);
      expect(await balancesOf()).toEqual({ [adaId]: 5000, [graceId]: -5000 });
    });

    it('is refused, with nothing kept, when the rates service does not answer in time', async () => {
      rates.answer = () => ({ status: 200, body: { rate: '0.9250' }, delayMs: 1000 });
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5400 } });
      expect(answer.body.type).toBe('NoRateOffered');
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('is refused, with nothing kept, when the converted amount is more than the payer owes', async () => {
      // 55.00 francs at 0.9250 is 50.875 → 51 euros: 1 euro more than Grace owes.
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 5500 } });
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('AmountTooLarge');
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('refuses an original in the group’s currency, or in a currency that is not one of Tally’s', async () => {
      expect((await settleInCash({ from: graceId, original: { currency: 'EUR', amount: 1000 } })).body).toMatchObject({
        type: 'InvalidCurrency',
      });
      expect((await settleInCash({ from: graceId, original: { currency: 'SEK', amount: 1000 } })).body).toMatchObject({
        type: 'InvalidCurrency',
      });
      expect(rates.requests).toHaveLength(0);
    });

    it.each([0, 100_000_001])('refuses an original amount of %i, outside 1 to 100 000 000', async amount => {
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount } });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidAmount');
    });

    it('refuses an original that converts to less than 1 hundredth, and keeps nothing', async () => {
      offers('0.4');
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 1 } });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidAmount');
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('refuses a body that gives neither amount nor original, or both, as the wrong shape', async () => {
      const neither = await settleInCash({ from: graceId });
      expect(neither.status).toBe(400);
      expect(neither.body.type).toBe('InvalidRequest');
      const both = await settleInCash({ from: graceId, amount: 1000, original: { currency: 'CHF', amount: 1000 } });
      expect(both.status).toBe(400);
      expect(both.body.type).toBe('InvalidRequest');
      expect(rates.requests).toHaveLength(0);
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('refuses an original whose amount is not a whole number', async () => {
      const answer = await settleInCash({ from: graceId, original: { currency: 'CHF', amount: 54.5 } });
      expect(answer.status).toBe(400);
    });

    it('answers 404 to an account outside the group, and keeps nothing', async () => {
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, original: { currency: 'CHF', amount: 5400 } },
        token: outsiderToken,
      });
      expect(answer.status).toBe(404);
      expect(rates.requests).toHaveLength(0);
    });
  });

  describe('paid through the provider', () => {
    it('asks the provider for the payment in the currency and amount paid, and keeps the settlement pending', async () => {
      const answer = await askProvider({ to: adaId, original: { currency: 'CHF', amount: 5400 } });
      expect(answer.status).toBe(201);
      expect(provider.requests).toEqual([
        {
          path: '/payments',
          body: { reference: answer.body.id, amount: 5400, currency: 'CHF', payee: adaPayout },
        },
      ]);
      expect((await readSettlement(answer.body.id, graceToken)).body).toEqual({
        id: answer.body.id,
        groupId,
        from: graceId,
        to: adaId,
        amount: 4995,
        method: 'provider',
        status: 'pending',
        at: expect.stringMatching(AT_PATTERN),
        payUrl: 'https://pay.example/pay_1',
        fee: { amount: 0, borneBy: 'payee' },
        original: { currency: 'CHF', amount: 5400, rate: '0.9250' },
        history: [{ status: 'pending', at: expect.stringMatching(AT_PATTERN) }],
      });
      expect(await balancesOf()).toEqual({ [adaId]: 5000, [graceId]: -5000 });
    });

    it('counts the converted amount once the provider says it succeeded, and what the rate was decided at', async () => {
      const { id } = (await askProvider({ to: adaId, original: { currency: 'CHF', amount: 5400 } })).body;
      expect((await sendWebhook('pay_1', 'succeeded')).status).toBe(204);
      expect((await readSettlement(id)).body).toMatchObject({ status: 'paid' });
      expect(await balancesOf()).toEqual({ [adaId]: 5, [graceId]: -5 });
    });

    it('converts the provider’s fee, in the currency paid, at the settlement’s rate, and bears it as the policy says', async () => {
      provider.answer = (request, number) =>
        request.body === undefined
          ? { status: 200, body: { id: decodeURIComponent(request.path.split('/').pop() ?? '') } }
          : { status: 201, body: { id: `pay_${number}`, payUrl: `https://pay.example/pay_${number}`, fee: 100 } };
      expect(
        (await call(app, 'PUT', `/groups/${groupId}/fee-policy`, { body: { borneBy: 'payer' }, token: adaToken }))
          .status,
      ).toBe(204);
      const { id } = (await askProvider({ to: adaId, original: { currency: 'CHF', amount: 5400 } })).body;
      // A fee of 1.00 franc is 0.925 euros, which rounds up to 93 hundredths of a euro.
      expect((await readSettlement(id)).body).toMatchObject({ fee: { amount: 93, borneBy: 'payer' } });
      expect((await sendWebhook('pay_1', 'succeeded')).status).toBe(204);
      // Grace, who bears the fee, pays 4995 - 93 of what is owed: 4902 settles.
      expect(await balancesOf()).toEqual({ [adaId]: 98, [graceId]: -98 });
    });

    it('is refused, with nothing kept, when the converted fee is not less than the converted amount', async () => {
      // 3 francs at 0.30 is 0.9, which rounds to 1; a fee of 2 francs is 0.6, which also rounds to 1: no answer.
      offers('0.30');
      provider.answer = (request, number) =>
        request.body === undefined
          ? { status: 200, body: { id: decodeURIComponent(request.path.split('/').pop() ?? '') } }
          : { status: 201, body: { id: `pay_${number}`, payUrl: 'https://pay.example/x', fee: 2 } };
      const answer = await askProvider({ to: adaId, original: { currency: 'CHF', amount: 3 } });
      expect(answer.status).toBe(424);
      expect(answer.body.type).toBe('ProviderUnavailable');
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('is refused, with the provider not asked and nothing kept, when no rate is offered', async () => {
      rates.answer = () => ({ status: 404 });
      const answer = await askProvider({ to: adaId, original: { currency: 'CHF', amount: 5400 } });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('NoRateOffered');
      expect(provider.requests).toHaveLength(0);
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('takes the rate decided when the payment was asked, for a payment the provider says later, and for its refund', async () => {
      const { id } = (await askProvider({ to: adaId, original: { currency: 'CHF', amount: 5400 } })).body;
      // The rate moves before the provider decides, and the payment is counted at the rate it was decided at.
      offers('0.5');
      expect((await sendWebhook('pay_1', 'succeeded')).status).toBe(204);
      expect(await balancesOf()).toEqual({ [adaId]: 5, [graceId]: -5 });
      // The refund counts the same 49.95 euros, not 27 at the rate now offered.
      expect((await call(app, 'POST', `/settlements/${id}/refund`, { token: adaToken })).status).toBe(204);
      expect((await sendWebhook('pay_1', 'refunded')).status).toBe(204);
      expect((await readSettlement(id)).body).toMatchObject({
        status: 'refunded',
        amount: 4995,
        original: { rate: '0.9250' },
      });
      expect(await balancesOf()).toEqual({ [adaId]: 5000, [graceId]: -5000 });
    });

    it('refuses a body that gives neither amount nor original, or both, as the wrong shape, and asks the provider nothing', async () => {
      const neither = await askProvider({ to: adaId });
      expect(neither.status).toBe(400);
      expect(neither.body.type).toBe('InvalidRequest');
      const both = await askProvider({ to: adaId, amount: 1000, original: { currency: 'CHF', amount: 1000 } });
      expect(both.status).toBe(400);
      expect(provider.requests).toHaveLength(0);
      expect(rates.requests).toHaveLength(0);
    });
  });
});
