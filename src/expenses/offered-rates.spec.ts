import { type Application, createApplication } from '../app';
import {
  type FakeRatesService,
  joinThroughInvitation,
  send,
  signedUpAccount,
  startFakeRatesService,
  temporaryDatabaseUrl,
} from '../test-support';
import { todayInUtc } from './validation';

describe('an expense in another currency, at the rate a rates service offers', () => {
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

  /** Ada owns a EUR group with Grace in it; answers their ids and tokens, and the group's id. */
  async function twoMembers(on: Application = app) {
    const ada = await signedUpAccount(on);
    const grace = await signedUpAccount(on, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(on, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(on, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  /** An expense body paid in CHF, with no rate unless `rate` is given, split equally between Ada and Grace. */
  const inChf = (
    ada: { id: string },
    grace: { id: string },
    original: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) => ({
    description: 'Dinner in Zurich',
    original: { currency: 'CHF', amount: 1000, ...original },
    date: todayInUtc(),
    splitBetween: [ada.id, grace.id],
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  async function readExpense(token: string, expenseId: string) {
    return send(app, 'GET', `/expenses/${expenseId}`, { token });
  }

  async function expensesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/expenses`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ id: string }[]>();
  }

  describe('recording it without a rate', () => {
    it('records it at the rate offered for its currency on today, and reads the rate back', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.9500');

      const response = await record(ada.token, groupId, inChf(ada, grace));
      expect(response.statusCode).toBe(201);

      const expense = (await readExpense(ada.token, response.json<{ id: string }>().id)).json();
      // 1000 at 0.95 is 950 in euros, split equally.
      expect(expense.amount).toBe(950);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1000, rate: '0.9500' });
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: todayInUtc() }]);
    });

    it('records it at the rate offered on the day of the expense, not on today', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', '2026-03-01', '1.0625');

      const response = await record(ada.token, groupId, inChf(ada, grace, {}, { date: '2026-03-01' }));
      expect(response.statusCode).toBe(201);

      const expense = (await readExpense(ada.token, response.json<{ id: string }>().id)).json();
      expect(expense.date).toBe('2026-03-01');
      expect(expense.amount).toBe(1063);
      expect(expense.original.rate).toBe('1.0625');
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: '2026-03-01' }]);
    });

    it('is refused with 409, and recorded nothing, when no rate is offered for its day', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', '2026-03-02', '0.95');

      const response = await record(ada.token, groupId, inChf(ada, grace, {}, { date: '2026-03-01' }));
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('NoRateOffered');
      expect(await expensesOf(ada.token, groupId)).toEqual([]);
    });

    it.each([
      ['refuses', 'refuse'],
      ['answers a rate that is not text', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('is refused with 409 when the rates service %s', async (_, mode) => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
      rates.mode = mode;

      const response = await record(ada.token, groupId, inChf(ada, grace));
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('NoRateOffered');
      expect(await expensesOf(ada.token, groupId)).toEqual([]);
    });

    it('is refused with 409 on a server started without a rates service', async () => {
      const without = await createApplication({ databaseUrl: await temporaryDatabaseUrl(), ratesUrl: '' });
      try {
        const { ada, grace, groupId } = await twoMembers(without);
        const response = await send(without, 'POST', `/groups/${groupId}/expenses`, {
          token: ada.token,
          payload: inChf(ada, grace),
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().type).toBe('NoRateOffered');
      } finally {
        await without.stop();
      }
    });

    it('asks nothing of the service for an expense in the group currency', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const response = await record(ada.token, groupId, {
        description: 'Groceries',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(response.statusCode).toBe(201);
      expect(rates.requests).toEqual([]);
    });

    it('is refused with 422, and asks nothing, for a currency Tally does not have or the group currency', async () => {
      const { ada, grace, groupId } = await twoMembers();
      for (const currency of ['JPY', 'EUR']) {
        const response = await record(ada.token, groupId, inChf(ada, grace, { currency }));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidOriginalCurrency');
      }
      expect(rates.requests).toEqual([]);
    });

    it('is refused with 422 for a date that is not a day, and not with a missing rate', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const response = await record(ada.token, groupId, inChf(ada, grace, {}, { date: '2026-02-30' }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidDate');
      expect(rates.requests).toEqual([]);
    });
  });

  describe('recording it with a rate of its own', () => {
    it.each(['0.931', '0.969', '0.95', '0.9500', '0.950000'])(
      'takes the rate %j, which is within 2 percent of the offered 0.95',
      async rate => {
        const { ada, grace, groupId } = await twoMembers();
        rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

        const response = await record(ada.token, groupId, inChf(ada, grace, { rate }));
        expect(response.statusCode).toBe(201);
        const expense = (await readExpense(ada.token, response.json<{ id: string }>().id)).json();
        expect(expense.original.rate).toBe(rate);
      },
    );

    it.each(['0.93', '0.97', '0.5', '1'])(
      'is refused with 422 when the rate %j differs by more than 2 percent',
      async rate => {
        const { ada, grace, groupId } = await twoMembers();
        rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

        const response = await record(ada.token, groupId, inChf(ada, grace, { rate }));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('RateDiffersFromOffered');
        expect(await expensesOf(ada.token, groupId)).toEqual([]);
      },
    );

    it('is refused with 409 when its rate cannot be checked, since no rate is offered', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
      rates.mode = 'refuse';

      const response = await record(ada.token, groupId, inChf(ada, grace, { rate: '0.95' }));
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('NoRateOffered');
    });

    it('is refused with 422 when its rate is not valid, whatever the offer', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

      const response = await record(ada.token, groupId, inChf(ada, grace, { rate: '0' }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidRate');
    });

    it('takes whatever rate it states on a server started without a rates service', async () => {
      const without = await createApplication({ databaseUrl: await temporaryDatabaseUrl(), ratesUrl: '' });
      try {
        const { ada, grace, groupId } = await twoMembers(without);
        const response = await send(without, 'POST', `/groups/${groupId}/expenses`, {
          token: ada.token,
          payload: inChf(ada, grace, { rate: '5' }),
        });
        expect(response.statusCode).toBe(201);
        const expense = await send(without, 'GET', `/expenses/${response.json<{ id: string }>().id}`, {
          token: ada.token,
        });
        expect(expense.json().amount).toBe(5000);
        expect(expense.json().original.rate).toBe('5');
      } finally {
        await without.stop();
      }
    });
  });

  describe('editing it', () => {
    /** Records a EUR expense of 900 split between Ada and Grace, and answers its id. */
    async function recordedInEuros(token: string, groupId: string, ada: { id: string }, grace: { id: string }) {
      const response = await record(token, groupId, {
        description: 'Dinner in Zurich',
        amount: 900,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    }

    const edit = (payload: Record<string, unknown>) => ({
      description: 'Dinner in Zurich',
      date: todayInUtc(),
      version: 1,
      splitBetween: [] as string[],
      ...payload,
    });

    it('takes the rate offered for its currency on its date, when the edit states none', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedInEuros(ada.token, groupId, ada, grace);
      rates.offer('CHF', 'EUR', '2026-03-01', '0.9');

      const edited = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit({
          date: '2026-03-01',
          original: { currency: 'CHF', amount: 1000 },
          splitBetween: [ada.id, grace.id],
        }),
      });
      expect(edited.statusCode).toBe(204);

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.version).toBe(2);
      expect(expense.amount).toBe(900);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1000, rate: '0.9' });
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: '2026-03-01' }]);
    });

    it('is refused with 409, and kept as it was, when no rate is offered for the edit', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedInEuros(ada.token, groupId, ada, grace);

      const refused = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit({ original: { currency: 'CHF', amount: 1000 }, splitBetween: [ada.id, grace.id] }),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('NoRateOffered');

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.version).toBe(1);
      expect(expense).not.toHaveProperty('original');
    });

    it('checks a rate the edit states against the offer, as recording does', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedInEuros(ada.token, groupId, ada, grace);
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');

      const refused = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit({ original: { currency: 'CHF', amount: 1000, rate: '0.93' }, splitBetween: [ada.id, grace.id] }),
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().type).toBe('RateDiffersFromOffered');
      expect((await readExpense(ada.token, id)).json().version).toBe(1);

      const accepted = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit({ original: { currency: 'CHF', amount: 1000, rate: '0.931' }, splitBetween: [ada.id, grace.id] }),
      });
      expect(accepted.statusCode).toBe(204);
      expect((await readExpense(ada.token, id)).json().amount).toBe(931);
    });

    it('asks the service for nothing when the edit is refused for who is editing', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedInEuros(ada.token, groupId, ada, grace);

      // Grace paid nothing and owns nothing: refused before any rate is asked for.
      const refused = await send(app, 'PUT', `/expenses/${id}`, {
        token: grace.token,
        payload: edit({ original: { currency: 'CHF', amount: 1000 }, splitBetween: [ada.id, grace.id] }),
      });
      expect(refused.statusCode).toBe(403);
      expect(rates.requests).toEqual([]);
    });
  });

  describe('reading it', () => {
    it('keeps the rate it was recorded at, when the offer changes afterwards', async () => {
      const { ada, grace, groupId } = await twoMembers();
      rates.offer('CHF', 'EUR', todayInUtc(), '0.95');
      const response = await record(ada.token, groupId, inChf(ada, grace));
      const id = response.json<{ id: string }>().id;

      rates.offer('CHF', 'EUR', todayInUtc(), '0.99');
      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.original.rate).toBe('0.95');
      expect(expense.amount).toBe(950);
    });
  });
});
