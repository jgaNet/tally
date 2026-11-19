import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeRatesService,
  joinThroughInvitation,
  send,
  signedUpAccount,
  startFakeRatesService,
  temporaryDatabaseUrl,
} from '../test-support';

describe('the rate a rates service offers', () => {
  let app: Application;
  let databaseUrl: string;
  let rates: FakeRatesService;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    rates = await startFakeRatesService();
    app = await createApplication({ databaseUrl, ratesUrl: rates.url, ratesTimeoutMs: 300 });
  });

  afterEach(async () => {
    await app.stop();
    await rates.close();
  });

  /** Ada owns a EUR group with Grace in it; Linus is in no group. Answers their tokens, and the group's id. */
  async function eurGroup(on: Application = app) {
    const ada = await signedUpAccount(on);
    const grace = await signedUpAccount(on, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(on, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(on, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(on, ada.token, grace.token, groupId);
    return { ada, grace, linus, groupId };
  }

  const offered = (token: string, groupId: string, currency: string, query = '') =>
    send(app, 'GET', `/groups/${groupId}/rates/${currency}${query}`, { token });

  it('answers the rate the service gives, from the currency to the group, on the day asked', async () => {
    const { ada, groupId } = await eurGroup();
    rates.offer('CHF', 'EUR', '2026-03-01', '0.9542');

    const response = await offered(ada.token, groupId, 'CHF', '?date=2026-03-01');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ currency: 'CHF', date: '2026-03-01', rate: '0.9542' });
    expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: '2026-03-01' }]);
  });

  it('answers for today when the date is left out', async () => {
    const { ada, groupId } = await eurGroup();
    rates.offer('USD', 'EUR', todayInUtc(), '0.8731');

    const response = await offered(ada.token, groupId, 'USD');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ currency: 'USD', date: todayInUtc(), rate: '0.8731' });
  });

  it('accepts a rate with up to 6 digits after the point, and a whole rate', async () => {
    const { ada, groupId } = await eurGroup();
    rates.offer('GBP', 'EUR', '2026-03-01', '1.123456');
    rates.offer('AUD', 'EUR', '2026-03-01', '2');

    expect((await offered(ada.token, groupId, 'GBP', '?date=2026-03-01')).json().rate).toBe('1.123456');
    expect((await offered(ada.token, groupId, 'AUD', '?date=2026-03-01')).json().rate).toBe('2');
  });

  it('is 404 when the service has no rate for that day, and asks it for that day only', async () => {
    const { ada, groupId } = await eurGroup();
    rates.offer('CHF', 'EUR', '2026-03-01', '0.95');

    const response = await offered(ada.token, groupId, 'CHF', '?date=2026-03-02');
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe('NoRateOffered');
    expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: '2026-03-02' }]);
  });

  it('is 404, and asks nothing, for the group currency or a currency Tally does not have', async () => {
    const { ada, groupId } = await eurGroup();
    rates.offer('EUR', 'EUR', todayInUtc(), '1');

    for (const currency of ['EUR', 'SEK']) {
      const response = await offered(ada.token, groupId, currency);
      expect(response.statusCode).toBe(404);
      expect(response.json().type).toBe('NoRateOffered');
    }
    expect(rates.requests).toEqual([]);
  });

  it('is 404 to anyone outside the group, as if the group were not there', async () => {
    const { groupId, linus } = await eurGroup();
    rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

    const response = await offered(linus.token, groupId, 'CHF');
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe('NotFound');
    expect(rates.requests).toEqual([]);
  });

  it('is 422 for a date that is not a day of the calendar, or not yet', async () => {
    const { ada, groupId } = await eurGroup();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    for (const date of ['2026-02-30', 'yesterday', tomorrow]) {
      const response = await offered(ada.token, groupId, 'CHF', `?date=${date}`);
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidDate');
    }
    expect(rates.requests).toEqual([]);
  });

  it.each(['0', '0.0000000', '1.1234567', '1e3', '-1', '.5', 'abc'])(
    'is 404 when the service answers the rate %j, which is not a decimal of up to 6 digits above 0',
    async rate => {
      const { ada, groupId } = await eurGroup();
      rates.offer('CHF', 'EUR', '2026-03-01', rate);

      const response = await offered(ada.token, groupId, 'CHF', '?date=2026-03-01');
      expect(response.statusCode).toBe(404);
    },
  );

  it.each([
    ['refuses', 'refuse'],
    ['answers a rate that is not text', 'malformed'],
    ['does not answer in time', 'hang'],
  ] as const)('is 404 when the service %s', async (_, mode) => {
    const { ada, groupId } = await eurGroup();
    rates.offer('CHF', 'EUR', '2026-03-01', '0.95');
    rates.mode = mode;

    const response = await offered(ada.token, groupId, 'CHF', '?date=2026-03-01');
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe('NoRateOffered');
  });

  it('is 404 when the service cannot be reached', async () => {
    const unreachable = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
      ratesUrl: 'http://127.0.0.1:1',
      ratesTimeoutMs: 300,
    });
    try {
      const { ada, groupId } = await eurGroup(unreachable);
      const response = await send(unreachable, 'GET', `/groups/${groupId}/rates/CHF`, { token: ada.token });
      expect(response.statusCode).toBe(404);
    } finally {
      await unreachable.stop();
    }
  });

  it('offers no rate at all on a server started without a rates service, and asks nothing', async () => {
    const without = await createApplication({ databaseUrl: await temporaryDatabaseUrl(), ratesUrl: '' });
    try {
      const { ada, groupId } = await eurGroup(without);
      const response = await send(without, 'GET', `/groups/${groupId}/rates/CHF`, { token: ada.token });
      expect(response.statusCode).toBe(404);
    } finally {
      await without.stop();
    }
  });

  it('asks the service at its base, however the base was given with a trailing slash', async () => {
    const slashed = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
      ratesUrl: `${rates.url}/`,
    });
    try {
      const { ada, groupId } = await eurGroup(slashed);
      rates.offer('CHF', 'EUR', '2026-03-01', '0.95');
      const response = await send(slashed, 'GET', `/groups/${groupId}/rates/CHF?date=2026-03-01`, {
        token: ada.token,
      });
      expect(response.json().rate).toBe('0.95');
    } finally {
      await slashed.stop();
    }
  });
});
