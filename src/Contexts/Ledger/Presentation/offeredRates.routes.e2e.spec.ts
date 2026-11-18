import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('offered-rates');

/**
 * The rates service, as a server of its own (request 22): it answers `GET /rates/{from}/{to}` with the rate the test set for that pair,
 * `404` for a pair it has no rate for, and an error while `failing` is set. Each request it gets is recorded, so a test reads what Tally
 * asked of it, the day included.
 */
let offers: Record<string, string>;
let failing: boolean;
let rateRequests: string[];
let ratesServer: Server;
let ratesOrigin: string;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  ratesServer = createServer((request, response) => {
    rateRequests.push(request.url ?? '');
    if (failing) {
      response.writeHead(500).end();
      return;
    }
    const match = /^\/rates\/([^/?]+)\/([^/?]+)\?/.exec(request.url ?? '');
    const rate = match ? offers[`${match[1]}/${match[2]}`] : undefined;
    if (rate === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => ratesServer.listen(0, '127.0.0.1', () => resolve()));
  ratesOrigin = `http://127.0.0.1:${(ratesServer.address() as AddressInfo).port}`;

  await database;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => ratesServer.close(() => resolve()));
  delete process.env.RATES_URL;
});
beforeEach(() => {
  offers = { 'CHF/EUR': '0.95', 'USD/EUR': '0.9545' };
  failing = false;
  rateRequests = [];
  process.env.RATES_URL = ratesOrigin;
});

const PASSWORD = 'a-good-password';
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group in EUR with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const readRate = (groupId: string, currency: string, query = '', token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/rates/${currency}${query}`, { token });
const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('the rate offered (request 22)', () => {
  it('offers the rate of a currency to the group’s on a day, as the service gives it, asking the service for that day', async () => {
    const ada = await signedIn('rate-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    const offered = await readRate(groupId, 'CHF', `?date=${PAST}`, ada.token);
    expect(offered.status).toBe(200);
    expect(offered.body).toEqual({ currency: 'CHF', date: PAST, rate: '0.95' });
    expect(rateRequests).toEqual([`/rates/CHF/EUR?date=${PAST}`]);
  });

  it('answers the day of today when the date is left out, and asks the service for that same day', async () => {
    const ada = await signedIn('rate-today@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    // The day is the one clock's today, which this suite does not read: the answer names the day it asked the service for.
    const offered = await readRate(groupId, 'USD', '', ada.token);
    expect(offered.status).toBe(200);
    const { date } = offered.body as { date: string };
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(offered.body).toEqual({ currency: 'USD', date, rate: '0.9545' });
    expect(rateRequests).toEqual([`/rates/USD/EUR?date=${date}`]);
  });

  it('answers 404 when no rate is offered: the service has none, a failure, or the currency is the group’s or not one of Tally’s', async () => {
    const ada = await signedIn('rate-none@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect((await readRate(groupId, 'GBP', `?date=${PAST}`, ada.token)).status).toBe(404); // the service has none
    expect((await readRate(groupId, 'EUR', `?date=${PAST}`, ada.token)).status).toBe(404); // the group's own
    expect((await readRate(groupId, 'XYZ', `?date=${PAST}`, ada.token)).status).toBe(404); // not one of Tally's
    expect((await readRate(groupId, 'CHF', '?date=2026-02-30', ada.token)).status).toBe(404); // not a real day
    failing = true;
    expect((await readRate(groupId, 'CHF', `?date=${PAST}`, ada.token)).status).toBe(404); // the service fails
  });

  it('answers 404 when no rates service is configured, and 401 to a missing caller', async () => {
    const ada = await signedIn('rate-unset@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    delete process.env.RATES_URL;
    expect((await readRate(groupId, 'CHF', `?date=${PAST}`, ada.token)).status).toBe(404);
    process.env.RATES_URL = ratesOrigin;
    expect((await readRate(groupId, 'CHF', `?date=${PAST}`)).status).toBe(401);
  });

  it('answers 404 to anyone outside the group, as if the group did not exist, and 400 to a date of the wrong shape', async () => {
    const ada = await signedIn('rate-ada2@example.com', 'Ada');
    const eve = await signedIn('rate-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);

    expect((await readRate(groupId, 'CHF', `?date=${PAST}`, eve.token)).status).toBe(404);
    expect((await readRate(groupId, 'CHF', '?date=15-01-2026', ada.token)).status).toBe(400);
  });
});

describe('an expense in another currency takes or corrects the rate offered (request 22)', () => {
  it('records an expense at the rate offered on its date when its rate is left out, and reads the rate back', async () => {
    const ada = await signedIn('offer-ada@example.com', 'Ada');
    const bob = await signedIn('offer-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    const created = await record(ada.token, groupId, {
      description: 'Zurich dinner',
      original: { currency: 'CHF', amount: 1000 },
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    expect(created.status).toBe(201);
    expect(rateRequests).toContain(`/rates/CHF/EUR?date=${PAST}`);

    const read = await readExpense((created.body as { id: string }).id, ada.token);
    expect(read.body).toMatchObject({ amount: 950, original: { currency: 'CHF', amount: 1000, rate: '0.95' } });
  });

  it('takes a rate the payer states within 2 % of the one offered, and refuses one more than 2 % away, by name', async () => {
    const ada = await signedIn('offer-band@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const base = { description: 'Rent', date: PAST, splitBetween: [ada.id] };
    const chf = (rate: string) => ({ ...base, original: { currency: 'CHF', amount: 1000, rate } });

    const taken = await record(ada.token, groupId, chf('0.931'));
    expect(taken.status).toBe(201);
    expect(await readExpense((taken.body as { id: string }).id, ada.token)).toMatchObject({
      body: { amount: 931, original: { rate: '0.931' } },
    });
    expect(await record(ada.token, groupId, chf('0.969'))).toMatchObject({ status: 201 });
    expect(await record(ada.token, groupId, chf('0.93'))).toMatchObject({
      status: 422,
      body: { type: 'RateOutsideBand' },
    });
    expect(await record(ada.token, groupId, chf('0.97'))).toMatchObject({
      status: 422,
      body: { type: 'RateOutsideBand' },
    });
  });

  it('refuses a rate left out, or stated, when the service offers none, by name, and refuses a rate that is not a decimal as such', async () => {
    const ada = await signedIn('offer-none@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const base = { description: 'Hotel', date: PAST, splitBetween: [ada.id] };

    // GBP has no rate on the service: left out, or stated, the expense is refused for want of a rate to compare with.
    expect(await record(ada.token, groupId, { ...base, original: { currency: 'GBP', amount: 500 } })).toMatchObject({
      status: 422,
      body: { type: 'NoRateOffered' },
    });
    expect(
      await record(ada.token, groupId, { ...base, original: { currency: 'GBP', amount: 500, rate: '1.2' } }),
    ).toMatchObject({ status: 422, body: { type: 'NoRateOffered' } });
    expect(
      await record(ada.token, groupId, { ...base, original: { currency: 'CHF', amount: 500, rate: 'abc' } }),
    ).toMatchObject({ status: 422, body: { type: 'InvalidRate' } });
  });

  it('with no rates service configured, takes the payer’s rate as request 21 does, and refuses a rate left out', async () => {
    const ada = await signedIn('offer-unset@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const base = { description: 'Train', date: PAST, splitBetween: [ada.id] };

    delete process.env.RATES_URL;
    try {
      const stated = await record(ada.token, groupId, {
        ...base,
        original: { currency: 'CHF', amount: 100, rate: '9.9' },
      });
      expect(stated.status).toBe(201);
      expect(await readExpense((stated.body as { id: string }).id, ada.token)).toMatchObject({
        body: { amount: 990, original: { rate: '9.9' } },
      });
      expect(await record(ada.token, groupId, { ...base, original: { currency: 'CHF', amount: 100 } })).toMatchObject({
        status: 422,
        body: { type: 'NoRateOffered' },
      });
    } finally {
      process.env.RATES_URL = ratesOrigin;
    }
    expect(rateRequests).toEqual([]);
  });

  it('edits an expense in another currency at the rate offered when its rate is left out, and refuses a rate outside the band', async () => {
    const ada = await signedIn('offer-edit@example.com', 'Ada');
    const bob = await signedIn('offer-edit-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const created = await record(ada.token, groupId, {
      description: 'Market',
      original: { currency: 'CHF', amount: 1000, rate: '0.95' },
      date: PAST,
      splitBetween: [ada.id, bob.id],
    });
    const id = (created.body as { id: string }).id;

    const edited = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ada.token,
      body: {
        description: 'Market',
        original: { currency: 'CHF', amount: 2000 },
        date: PAST,
        splitBetween: [ada.id, bob.id],
        version: 1,
      },
    });
    expect(edited.status).toBe(204);
    expect(await readExpense(id, ada.token)).toMatchObject({
      body: { version: 2, amount: 1900, original: { currency: 'CHF', amount: 2000, rate: '0.95' } },
    });

    const refused = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ada.token,
      body: {
        description: 'Market',
        original: { currency: 'CHF', amount: 2000, rate: '0.5' },
        date: PAST,
        splitBetween: [ada.id, bob.id],
        version: 2,
      },
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'RateOutsideBand' } });
  });
});
