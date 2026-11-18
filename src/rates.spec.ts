import { Application } from './app';
import { todayUtc } from './days';
import { ada, call, FakeRates, startApplication, startFakeRates, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const DAY = '2026-11-01';
const NEXT_DAY = '2026-11-02';

describe('the rates offered', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let rates: FakeRates;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let outsiderToken: string;
  let groupId: string;

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

  /** Asks for the rate offered for a currency, by the account that signs the request with `token`. */
  const offered = (currency: string, query = '', token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/rates/${currency}${query}`, { token });

  beforeEach(async () => {
    database = temporaryDatabase();
    rates = await startFakeRates();
    app = await startApplication(database.url, { ratesUrl: rates.url, ratesTimeoutMs: 300 });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken })).status).toBe(
      204,
    );
  });

  afterEach(async () => {
    await app.stop();
    await rates.stop();
    await database.remove();
  });

  describe('reading the rate offered', () => {
    it('answers the rate the rates service gives, from the currency to the group’s, on the day asked for', async () => {
      offers('0.95');
      const answer = await offered('CHF', `?date=${DAY}`);
      expect(answer).toEqual({ status: 200, body: { currency: 'CHF', date: DAY, rate: '0.95' } });
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: DAY }]);
    });

    it('asks for today when no day is given, and answers that day', async () => {
      offers('0.95');
      const answer = await offered('USD');
      expect(answer.body).toEqual({ currency: 'USD', date: todayUtc(), rate: '0.95' });
      expect(rates.requests).toEqual([{ from: 'USD', to: 'EUR', date: todayUtc() }]);
    });

    it('answers any member of the group, not only its owner', async () => {
      offers('0.95');
      expect((await offered('CHF', `?date=${DAY}`, graceToken)).status).toBe(200);
    });

    it('answers 404 when the rates service has no rate for the day', async () => {
      rates.answer = () => ({ status: 404 });
      expect(await offered('CHF', `?date=${DAY}`)).toEqual({
        status: 404,
        body: { type: 'NoRateOffered', message: expect.any(String) },
      });
    });

    it.each([
      ['a status other than 200', { status: 500, body: { rate: '0.95' } }],
      ['an answer that is not JSON', { status: 200, raw: 'EUR 0.95' }],
      ['an answer that is null', { status: 200, raw: 'null' }],
      ['an answer with no rate', { status: 200, body: {} }],
      ['a rate that is a number, not a string', { status: 200, body: { rate: 0.95 } }],
      ['a rate of 0', { status: 200, body: { rate: '0' } }],
      ['a negative rate', { status: 200, body: { rate: '-0.5' } }],
      ['a rate with 7 digits after the point', { status: 200, body: { rate: '0.1234567' } }],
      ['a rate with a comma', { status: 200, body: { rate: '1,5' } }],
      ['an empty rate', { status: 200, body: { rate: '' } }],
      ['a rate that is not a number', { status: 200, body: { rate: 'abc' } }],
    ])('answers 404 when the answer is %s', async (_, answer) => {
      rates.answer = () => answer;
      expect((await offered('CHF', `?date=${DAY}`)).status).toBe(404);
    });

    it('answers 404 when the rates service does not answer within the time allowed', async () => {
      rates.answer = () => ({ status: 200, body: { rate: '0.95' }, delayMs: 1000 });
      expect((await offered('CHF', `?date=${DAY}`)).status).toBe(404);
    });

    it('answers 404, without asking the rates service, for the group’s own currency and for a currency of no Tally', async () => {
      offers('0.95');
      expect((await offered('EUR', `?date=${DAY}`)).status).toBe(404);
      expect((await offered('SEK', `?date=${DAY}`)).status).toBe(404);
      expect(rates.requests).toEqual([]);
    });

    it('answers 404 to an account that is not a member of the group, as for a group that does not exist', async () => {
      offers('0.95');
      expect(await offered('CHF', `?date=${DAY}`, outsiderToken)).toEqual({
        status: 404,
        body: { type: 'NotFound', message: expect.any(String) },
      });
      expect(rates.requests).toEqual([]);
    });

    it('refuses a day that is not one of the calendar with 422, and a day not written as YYYY-MM-DD with 400', async () => {
      offers('0.95');
      expect((await offered('CHF', '?date=2026-02-30')).status).toBe(422);
      expect((await offered('CHF', '?date=yesterday')).status).toBe(400);
      expect(rates.requests).toEqual([]);
    });

    it('offers no rate on a server without a rates service', async () => {
      const other = await startApplication(database.url);
      try {
        expect((await offered('CHF', `?date=${DAY}`, adaToken, other)).status).toBe(404);
      } finally {
        await other.stop();
      }
    });
  });

  describe('an expense in another currency, at the rate offered', () => {
    const francs = (fields: Record<string, unknown> = {}) => ({ currency: 'CHF', amount: 1000, ...fields });

    const expense = (fields: Record<string, unknown> = {}) => ({
      description: 'Dinner',
      date: DAY,
      original: francs(),
      splitBetween: [adaId, graceId],
      ...fields,
    });

    /** Records an expense by the account, on the application given. */
    const record = (fields: Record<string, unknown> = {}, using: Application = app) =>
      call(using, 'POST', `/groups/${groupId}/expenses`, { body: expense(fields), token: adaToken });

    /** Edits the expense from its first version, in place of the one recorded. */
    const change = (id: string, fields: Record<string, unknown> = {}) =>
      call(app, 'PUT', `/expenses/${id}`, { body: { ...expense(), version: 1, ...fields }, token: adaToken });

    const readExpense = async (id: string) => (await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).body;

    const refusal = (type: string) => ({ status: 422, body: { type, message: expect.any(String) } });

    /** Records an expense that must be recorded, and answers its id. */
    async function recordedId(fields: Record<string, unknown> = {}): Promise<string> {
      const answer = await record(fields);
      expect(answer.status).toBe(201);
      return answer.body.id;
    }

    it('takes the rate offered when the rate is left out, asked for the expense’s day, and records the expense at it', async () => {
      offers('0.95');
      const id = await recordedId();
      expect(rates.requests).toEqual([{ from: 'CHF', to: 'EUR', date: DAY }]);
      expect(await readExpense(id)).toMatchObject({
        amount: 950,
        original: { currency: 'CHF', amount: 1000, rate: '0.95' },
      });
    });

    it('refuses an expense with no rate when no rate is offered, and records nothing', async () => {
      rates.answer = () => ({ status: 404 });
      expect(await record()).toEqual(refusal('NoRateOffered'));
      const listed = await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken });
      expect(listed.body).toEqual([]);
    });

    it('refuses an expense with no rate when the rates service does not answer in time', async () => {
      rates.answer = () => ({ status: 200, body: { rate: '0.95' }, delayMs: 1000 });
      expect(await record()).toEqual(refusal('NoRateOffered'));
    });

    it('refuses an expense with no rate on a server without a rates service', async () => {
      const other = await startApplication(database.url);
      try {
        expect(await record({}, other)).toEqual(refusal('NoRateOffered'));
      } finally {
        await other.stop();
      }
    });

    it.each(['0.95', '0.931', '0.969'])('takes the rate %s, which is within 2 %% of the rate offered', async given => {
      offers('0.95');
      const answer = await record({ original: francs({ rate: given }) });
      expect(answer.status).toBe(201);
      expect(await readExpense(answer.body.id)).toMatchObject({ original: { rate: given } });
    });

    it.each(['0.93', '0.97', '1.2'])(
      'refuses the rate %s, which differs from the rate offered by more than 2 %%',
      async given => {
        offers('0.95');
        expect(await record({ original: francs({ rate: given }) })).toEqual(refusal('RateDiffersFromOffered'));
      },
    );

    it('refuses a rate given when no rate is offered to compare it with', async () => {
      rates.answer = () => ({ status: 404 });
      expect(await record({ original: francs({ rate: '0.95' }) })).toEqual(refusal('NoRateOffered'));
    });

    it('refuses a rate given that is not a rate, even where a rate is offered', async () => {
      offers('0.95');
      expect(await record({ original: francs({ rate: '0' }) })).toEqual(refusal('InvalidRate'));
    });

    it('takes the rate given on a server without a rates service, whatever it is', async () => {
      const other = await startApplication(database.url);
      try {
        const answer = await record({ original: francs({ rate: '0.5' }) }, other);
        expect(answer.status).toBe(201);
        expect(await readExpense(answer.body.id)).toMatchObject({ amount: 500, original: { rate: '0.5' } });
      } finally {
        await other.stop();
      }
    });

    it('asks nothing of the rates service for an expense in the group’s currency', async () => {
      offers('0.95');
      expect((await record({ original: undefined, amount: 1000 })).status).toBe(201);
      expect(rates.requests).toEqual([]);
    });

    it('takes the rate offered on the new day when an edit gives a new day and leaves the rate out', async () => {
      rates.answer = request => ({ status: 200, body: { rate: request.date === NEXT_DAY ? '1.5' : '0.95' } });
      const id = await recordedId();
      expect((await change(id, { date: NEXT_DAY, original: francs({ amount: 2000 }), version: 1 })).status).toBe(204);
      expect(rates.requests.at(-1)).toEqual({ from: 'CHF', to: 'EUR', date: NEXT_DAY });
      expect(await readExpense(id)).toMatchObject({
        version: 2,
        amount: 3000,
        original: { amount: 2000, rate: '1.5' },
      });
    });

    it('refuses an edit whose rate differs from the rate offered on its day, and keeps the expense as it was', async () => {
      rates.answer = request => ({ status: 200, body: { rate: request.date === NEXT_DAY ? '1.5' : '0.95' } });
      const id = await recordedId();
      expect(await change(id, { date: NEXT_DAY, original: francs({ rate: '0.95' }), version: 1 })).toEqual(
        refusal('RateDiffersFromOffered'),
      );
      expect(await readExpense(id)).toMatchObject({ version: 1, date: DAY, amount: 950, original: { rate: '0.95' } });
    });

    it('reads the rate it was recorded at: the one offered, or the one given', async () => {
      offers('0.95');
      const offeredId = await recordedId();
      const givenId = await recordedId({ original: francs({ rate: '0.931' }) });
      expect(await readExpense(offeredId)).toMatchObject({ original: { rate: '0.95' } });
      expect(await readExpense(givenId)).toMatchObject({ amount: 931, original: { rate: '0.931' } });
    });
  });
});
