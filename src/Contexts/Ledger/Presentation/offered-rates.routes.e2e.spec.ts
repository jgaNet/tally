import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The rates offered (request 22, the API's fragment 22), over HTTP against a database file and a fake rates service on a local port:
 * the rate a member reads for a currency and a day (today when none is given) as the service gives it; the rate an expense in another
 * currency takes when its own is left out, and the one it is checked against within 2 %; and the refusals, by name, with nothing kept.
 * A second application with no rates service configured takes a stated rate as request 21 does, and refuses one left out.
 */
let directory: string;
let rates: Server;
let ratesUrl: string;
/** How the fake service answers: a rate for each pair it has, a failure, an answer that is no rate, or no answer at all. */
let ratesMode: 'ok' | 'down' | 'junk' | 'hang';
/** The days the service has no rate for: it answers `404` for them. */
let missingDays: Set<string>;
/** The requests Tally made to the service, as `from/to/date`. */
let asked: string[];

/** What one unit of the fake service is worth in the other, for each pair the service knows. */
const RATE_OF: Record<string, string> = { 'USD/EUR': '0.95', 'CHF/EUR': '1.0625' };
const PAST_DAY = '2026-03-02';
const MISSING_DAY = '2020-01-15';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

let app: FastifyApplication;
let appWithoutService: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let httpWithoutService: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-offered-rates-'));
  rates = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://rates.local');
    const pair = /^\/rates\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const date = url.searchParams.get('date') ?? '';
    if (req.method !== 'GET' || !pair) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    asked.push(`${pair[1]}/${pair[2]}/${date}`);
    if (ratesMode === 'hang') return;
    if (ratesMode === 'down') {
      res.statusCode = 503;
      res.end('unavailable');
      return;
    }
    const rate = RATE_OF[`${pair[1]}/${pair[2]}`];
    res.setHeader('content-type', 'application/json');
    if (ratesMode === 'junk') {
      res.statusCode = 200;
      res.end(JSON.stringify({ rate: '0' }));
      return;
    }
    if (!rate || missingDays.has(date)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'no rate' }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', resolve));
  ratesUrl = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;

  app = await createApplication({
    databasePath: join(directory, 'with.sqlite'),
    logger: silent,
    ratesUrl,
    jobsIntervalSeconds: 3600,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;

  appWithoutService = await createApplication({
    databasePath: join(directory, 'without.sqlite'),
    logger: silent,
    jobsIntervalSeconds: 3600,
  });
  await appWithoutService.start(0);
  httpWithoutService = apiClient(appWithoutService.address);
});

beforeEach(() => {
  ratesMode = 'ok';
  missingDays = new Set([MISSING_DAY]);
  asked = [];
});

afterAll(async () => {
  await app.stop();
  await appWithoutService.stop();
  rates.closeAllConnections();
  await new Promise(resolve => rates.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person of one application: their token and their account id. */
async function person(client: ReturnType<typeof apiClient>, name: string, email: string) {
  await client.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await client.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await client.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

/** A group in euros with Bob in it, in the application the client talks to. */
async function groupWithBob(client: ReturnType<typeof apiClient>, ann: { token: string }, bob: { token: string }) {
  const created = await client.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Zurich', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await client.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await client.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  return groupId;
}

type Person = Awaited<ReturnType<typeof person>>;
let ann: Person;
let bob: Person;
let eve: Person;
let groupId: string;
let annWithout: Person;
let bobWithout: Person;
let groupWithout: string;

beforeAll(async () => {
  ann = await person(http, 'Ann', 'ann@example.com');
  bob = await person(http, 'Bob', 'bob@example.com');
  eve = await person(http, 'Eve', 'eve@example.com');
  groupId = await groupWithBob(http, ann, bob);
  annWithout = await person(httpWithoutService, 'Ann', 'ann@example.com');
  bobWithout = await person(httpWithoutService, 'Bob', 'bob@example.com');
  groupWithout = await groupWithBob(httpWithoutService, annWithout, bobWithout);
});

const rateOf = (currency: string, date?: string, token: string | undefined = bob.token, groupOf = groupId) =>
  http.request('GET', `${api}/groups/${groupOf}/rates/${currency}${date ? `?date=${date}` : ''}`, { token });

const record = (body: Record<string, unknown>, client = http, token = ann.token, groupOf = groupId) =>
  client.request('POST', `${api}/groups/${groupOf}/expenses`, { token, body });

const expenseBody = (original: Record<string, unknown>, date = PAST_DAY) => ({
  description: 'Train',
  original: { currency: 'USD', amount: 1000, ...original },
  date,
  splitBetween: [] as string[],
});

describe('reading the rate offered', () => {
  it('answers the rate the service gives for the currency and the day, to a member', async () => {
    const { status, body } = await rateOf('USD', PAST_DAY);
    expect(status).toBe(200);
    expect(body).toEqual({ currency: 'USD', date: PAST_DAY, rate: '0.95' });
    expect(asked).toContain(`USD/EUR/${PAST_DAY}`);
  });

  it('answers the rate of the day the application counts as today when no day is given', async () => {
    // The day is the one the wiring's clock gives, which a test does not read: the answer names it, and the service was asked for it.
    const { status, body } = await rateOf('CHF');
    expect(status).toBe(200);
    const { date } = body as { date: string };
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body).toEqual({ currency: 'CHF', date, rate: '1.0625' });
    expect(asked).toContain(`CHF/EUR/${date}`);
  });

  it('answers 404 when the service has no rate for the day, or for a currency it does not know', async () => {
    expect((await rateOf('USD', MISSING_DAY)).status).toBe(404);
    expect((await rateOf('JPY', PAST_DAY)).status).toBe(404);
  });

  it('answers 404 for the group’s own currency, and for a day that is not a real one', async () => {
    expect((await rateOf('EUR', PAST_DAY)).status).toBe(404);
    expect((await rateOf('USD', '2026-02-30')).status).toBe(404);
  });

  it('answers 404 to someone who is not a member, and 401 to nobody signed in', async () => {
    expect((await rateOf('USD', PAST_DAY, eve.token)).status).toBe(404);
    expect((await http.request('GET', `${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`)).status).toBe(401);
  });

  it('answers 404 when the service fails or answers something that is no rate', async () => {
    ratesMode = 'down';
    expect((await rateOf('USD', PAST_DAY)).status).toBe(404);
    ratesMode = 'junk';
    const junk = await rateOf('USD', PAST_DAY);
    expect([junk.status, junk.body]).toEqual([
      404,
      { type: 'NotFound', message: 'No rate is offered for this currency on this day' },
    ]);
  });

  it('answers 404 when the service does not answer within 5 seconds', async () => {
    ratesMode = 'hang';
    const { status } = await rateOf('USD', PAST_DAY);
    expect(status).toBe(404);
  }, 15000);

  it('answers 404 when no rates service is configured', async () => {
    const { status } = await httpWithoutService.request(
      'GET',
      `${api}/groups/${groupWithout}/rates/USD?date=${PAST_DAY}`,
      {
        token: bobWithout.token,
      },
    );
    expect(status).toBe(404);
  });
});

describe('recording an expense at the rate offered', () => {
  it('is recorded at the rate offered on its day when its rate is left out, and reads it back', async () => {
    const recorded = await record({ ...expenseBody({}), splitBetween: [ann.id, bob.id] });
    expect(recorded.status).toBe(201);
    expect(asked).toContain(`USD/EUR/${PAST_DAY}`);

    const { status, body } = await http.request('GET', `${api}/expenses/${(recorded.body as { id: string }).id}`, {
      token: bob.token,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ amount: 950, original: { currency: 'USD', amount: 1000, rate: '0.95' } });
  });

  it('is refused by name when its rate is left out and no rate is offered for its day, and nothing is kept', async () => {
    const before = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: bob.token }))
      .body as unknown[];
    const refused = await record({ ...expenseBody({}, MISSING_DAY), splitBetween: [ann.id, bob.id] });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'NoRateOffered', message: expect.any(String) });
    const after = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: bob.token }))
      .body as unknown[];
    expect(after.length).toBe(before.length);
  });

  it('keeps a stated rate within 2 % of the offered one, and reads it back as given', async () => {
    for (const rate of ['0.931', '0.969']) {
      const recorded = await record({ ...expenseBody({ rate }), splitBetween: [ann.id, bob.id] });
      expect(recorded.status).toBe(201);
      const { body } = await http.request('GET', `${api}/expenses/${(recorded.body as { id: string }).id}`, {
        token: bob.token,
      });
      expect(body).toMatchObject({ original: { rate } });
    }
  });

  it('refuses a stated rate beyond 2 % of the offered one, by name', async () => {
    for (const rate of ['0.93', '0.97']) {
      const refused = await record({ ...expenseBody({ rate }), splitBetween: [ann.id, bob.id] });
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({ type: 'RateOutsideBand', message: expect.any(String) });
    }
  });

  it('refuses a stated rate when no rate is offered for its day, by name', async () => {
    const refused = await record({ ...expenseBody({ rate: '0.95' }, MISSING_DAY), splitBetween: [ann.id, bob.id] });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
  });

  it('refuses a stated rate the service offers for a day it could not answer, when the service is down', async () => {
    ratesMode = 'down';
    const refused = await record({ ...expenseBody({ rate: '0.95' }), splitBetween: [ann.id, bob.id] });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
  });
});

describe('editing an expense at the rate offered', () => {
  it('takes the rate offered on the new day, and checks a stated one against it', async () => {
    const recorded = await record({ ...expenseBody({}), splitBetween: [ann.id, bob.id] });
    const id = (recorded.body as { id: string }).id;
    const { version } = (await http.request('GET', `${api}/expenses/${id}`, { token: ann.token })).body as {
      version: number;
    };

    const edited = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ann.token,
      body: {
        ...expenseBody({ currency: 'CHF', amount: 2000 }, '2026-03-03'),
        splitBetween: [ann.id, bob.id],
        version,
      },
    });
    expect(edited.status).toBe(204);
    const read = await http.request('GET', `${api}/expenses/${id}`, { token: ann.token });
    expect(read.body).toMatchObject({ amount: 2125, original: { currency: 'CHF', amount: 2000, rate: '1.0625' } });
    expect(asked).toContain(`CHF/EUR/2026-03-03`);

    const outside = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ann.token,
      body: {
        ...expenseBody({ rate: '0.5' }),
        splitBetween: [ann.id, bob.id],
        version: version + 1,
      },
    });
    expect(outside.status).toBe(422);
    expect(outside.body).toEqual({ type: 'RateOutsideBand', message: expect.any(String) });
  });
});

describe('with no rates service configured (request 21)', () => {
  it('takes a stated rate whatever it is, and refuses one left out, by name', async () => {
    const stated = await record(
      { ...expenseBody({ rate: '3.7' }), splitBetween: [annWithout.id, bobWithout.id] },
      httpWithoutService,
      annWithout.token,
      groupWithout,
    );
    expect(stated.status).toBe(201);
    const { body } = await httpWithoutService.request('GET', `${api}/expenses/${(stated.body as { id: string }).id}`, {
      token: bobWithout.token,
    });
    expect(body).toMatchObject({ original: { rate: '3.7' } });

    const left = await record(
      { ...expenseBody({}), splitBetween: [annWithout.id, bobWithout.id] },
      httpWithoutService,
      annWithout.token,
      groupWithout,
    );
    expect(left.status).toBe(422);
    expect(left.body).toMatchObject({ type: 'NoRateOffered' });
  });
});

describe('Groups → Ledger (GroupCurrency, GroupMembers)', () => {
  it('finds a group made in Groups by the id its creation answered: Ledger reads its currency and its members through the API', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Lyon', currency: 'EUR' },
    });
    const id = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${id}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    // Ledger reads the group's currency through Groups: the group's own currency has no rate to offer, another one does.
    expect(
      (await http.request('GET', `${api}/groups/${id}/rates/EUR?date=${PAST_DAY}`, { token: bob.token })).status,
    ).toBe(404);
    const offered = await http.request('GET', `${api}/groups/${id}/rates/USD?date=${PAST_DAY}`, { token: bob.token });
    expect(offered.status).toBe(200);
    expect(offered.body).toEqual({ currency: 'USD', date: PAST_DAY, rate: '0.95' });

    // Ledger reads the members through Groups: a member who joined is one of them, a stranger is not.
    expect(
      (await http.request('GET', `${api}/groups/${id}/rates/USD?date=${PAST_DAY}`, { token: eve.token })).status,
    ).toBe(404);
  });
});
