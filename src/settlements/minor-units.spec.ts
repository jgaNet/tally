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

describe('settling up in a currency of another minor unit', () => {
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
      providerWebhookSecret: 'shared-secret',
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

  /**
   * Ada owns a group in `currency` with Grace in it. Ada paid `paid` split between the two, so Grace owes Ada half of it.
   * Ada has a payout account at the provider.
   */
  async function graceOwesAda(currency: string, paid: number) {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', { token: ada.token, payload: { name: 'Trip', currency } });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await setPayoutAccount(app, ada.token, 'acct-ada');
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Dinner', amount: paid, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  async function balanceOf(token: string, groupId: string, memberId: string): Promise<number> {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>().find(entry => entry.memberId === memberId)!.balance;
  }

  describe('a cash settlement in another currency, at the rate offered today', () => {
    it('is 12.50 euros at 161.5 yen, so 2019 yen, and the balances count the yen', async () => {
      const { ada, grace, groupId } = await graceOwesAda('JPY', 6000);
      rates.offer('EUR', 'JPY', todayInUtc(), '161.5');

      const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: grace.id, original: { currency: 'EUR', amount: 1250 } },
      });
      expect(response.statusCode).toBe(201);
      const settlement = await send(app, 'GET', `/settlements/${response.json<{ id: string }>().id}`, {
        token: ada.token,
      });
      expect(settlement.json()).toMatchObject({
        amount: 2019,
        original: { currency: 'EUR', amount: 1250, rate: '161.5' },
      });
      // Grace owed 3000 yen; 2019 of it is paid.
      expect(await balanceOf(ada.token, groupId, grace.id)).toBe(-981);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(981);
    });

    it('is 9 dollars at 0.3075 dinars, so 2767.5 fils, rounded half up to 2768 thousandths', async () => {
      const { ada, grace, groupId } = await graceOwesAda('KWD', 6000);
      rates.offer('USD', 'KWD', todayInUtc(), '0.3075');

      const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: grace.id, original: { currency: 'USD', amount: 900 } },
      });
      expect(response.statusCode).toBe(201);
      const settlement = await send(app, 'GET', `/settlements/${response.json<{ id: string }>().id}`, {
        token: ada.token,
      });
      expect(settlement.json()).toMatchObject({ amount: 2768 });
    });

    it('is 4000 yen at 0.0062 euros, so 24.80 euros, which is 2480 hundredths', async () => {
      const { ada, grace, groupId } = await graceOwesAda('EUR', 6000);
      rates.offer('JPY', 'EUR', todayInUtc(), '0.0062');

      const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: grace.id, original: { currency: 'JPY', amount: 4000 } },
      });
      expect(response.statusCode).toBe(201);
      expect(await balanceOf(ada.token, groupId, grace.id)).toBe(-520);
    });

    it('is refused when, in the group’s minor unit, it pays more than is owed', async () => {
      const { ada, grace, groupId } = await graceOwesAda('EUR', 6000);
      rates.offer('JPY', 'EUR', todayInUtc(), '0.0062');

      // 10 000 yen is 62 euros, which is 6200 hundredths: more than the 3000 that Grace owes.
      const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: grace.id, original: { currency: 'JPY', amount: 10_000 } },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('MoreThanIsOwed');
    });
  });

  describe('a payment through the provider, whose fee is in the minor unit of its currency', () => {
    it('asks for the payment in yen, and converts the fee of 100 yen to 62 euro cents', async () => {
      const { ada, grace, groupId } = await graceOwesAda('EUR', 6000);
      rates.offer('JPY', 'EUR', todayInUtc(), '0.0062');
      provider.fee = 100;

      const response = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: grace.token,
        payload: { to: ada.id, original: { currency: 'JPY', amount: 4000 } },
      });
      expect(response.statusCode).toBe(201);
      expect(provider.requests).toEqual([expect.objectContaining({ amount: 4000, currency: 'JPY' })]);

      const settlement = await send(app, 'GET', `/settlements/${response.json<{ id: string }>().id}`, {
        token: grace.token,
      });
      expect(settlement.json()).toMatchObject({ amount: 2480, fee: { amount: 62, borneBy: 'payee' } });
    });
  });

  describe('the rate offered', () => {
    it('is offered for a currency of any minor unit, dinars included', async () => {
      const { ada, groupId } = await graceOwesAda('EUR', 6000);
      rates.offer('KWD', 'EUR', todayInUtc(), '2.95');

      const response = await send(app, 'GET', `/groups/${groupId}/rates/KWD`, { token: ada.token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ currency: 'KWD', date: todayInUtc(), rate: '2.95' });
    });
  });
});
