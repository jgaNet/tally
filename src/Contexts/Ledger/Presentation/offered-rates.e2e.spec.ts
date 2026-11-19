import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 22 over HTTP: the rate a rates service offers, read at `GET /groups/{id}/rates/{currency}`, and an expense in another currency
 * that takes it when its rate is left out, or corrects it within 2 %. The rates service is a fake one, on a port of its own; `RATES_URL`
 * is read at each request, so a test can take it away. Every answer is held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** A fake rates service: `GET /rates/{from}/{to}?date=` answers `200 { rate }` for a rate it has, `404` otherwise, `500` while it is down. */
let rates: Server;
let ratesOrigin: string;
let ratesDown = false;
/** The rates it has, keyed `from/to/date`, or `from/to/*` for every day. */
const offers = new Map<string, string>();
/** The days it was asked for, in order: a test reads the day Tally asked for, never the machine's clock. */
let asked: string[] = [];

beforeAll(async () => {
  rates = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://rates.test');
    const [, , from, to] = url.pathname.split('/');
    const day = url.searchParams.get('date') ?? '';
    asked = [...asked, day];
    if (ratesDown) {
      response.writeHead(500).end();
      return;
    }
    const rate = offers.get(`${from}/${to}/${day}`) ?? offers.get(`${from}/${to}/*`);
    if (rate === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', () => resolve()));
  ratesOrigin = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.RATES_URL = ratesOrigin;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => rates.close(resolve));
});
beforeEach(() => {
  process.env.RATES_URL = ratesOrigin;
  ratesDown = false;
  offers.clear();
  offers.set('CHF/EUR/2026-11-16', '0.95');
  asked = [];
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A EUR group owned by `owner`, which each of `others` has joined through an invitation. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const getRate = (groupId: string, currency: string, query = '', token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/rates/${currency}${query}`, { token });
const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const edit = (id: string, body: Record<string, unknown>, token?: string) =>
  http.request('PUT', `${api}/expenses/${id}`, { body, token });
const getExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('the rate offered', () => {
  it('answers the rate the service gives for a currency to the group’s on the day asked', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const answer = await getRate(groupId, 'CHF', '?date=2026-11-16', ada.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ currency: 'CHF', date: '2026-11-16', rate: '0.95' });
  });

  it('answers today’s rate when no day is asked', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    // Every day has a rate for this one test: the day asked for is whatever today is for the machine.
    offers.set('CHF/EUR/*', '0.9');
    const answer = await getRate(groupId, 'CHF', '', ada.token);
    expect(answer.status).toBe(200);
    // The day asked for is the one Tally took as today: a real day, which the answer names.
    const [day] = asked;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(answer.body).toEqual({ currency: 'CHF', date: day, rate: '0.9' });
  });

  it('answers 404 when the service has no rate for that day, or is down, or gives a rate that is not one', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    expect((await getRate(groupId, 'CHF', '?date=2026-11-01', ada.token)).status).toBe(404);
    ratesDown = true;
    expect((await getRate(groupId, 'CHF', '?date=2026-11-16', ada.token)).status).toBe(404);
    ratesDown = false;
    offers.set('CHF/EUR/2026-11-15', '0.9.5');
    expect((await getRate(groupId, 'CHF', '?date=2026-11-15', ada.token)).status).toBe(404);
  });

  it('answers 404 for the group’s own currency and for a currency that is not Tally’s', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    expect((await getRate(groupId, 'EUR', '?date=2026-11-16', ada.token)).status).toBe(404);
    expect((await getRate(groupId, 'CNY', '?date=2026-11-16', ada.token)).status).toBe(404);
  });

  it('answers 404 when no rates service is configured', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    delete process.env.RATES_URL;

    expect((await getRate(groupId, 'CHF', '?date=2026-11-16', ada.token)).status).toBe(404);
  });

  it('refuses a day that is not a real day by name, and a caller who is not signed in with 401', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const notADay = await getRate(groupId, 'CHF', '?date=2026-02-30', ada.token);
    expect(notADay.status).toBe(400);
    expect(notADay.body).toMatchObject({ type: 'InvalidRateDate' });
    expect((await getRate(groupId, 'CHF', '', undefined)).status).toBe(401);
  });

  it('answers 404 to a person who is not a member of the group', async () => {
    const ada = await signedInPerson('Ada');
    const stranger = await signedInPerson('Stranger');
    const groupId = await groupWith(ada, []);

    expect((await getRate(groupId, 'CHF', '?date=2026-11-16', stranger.token)).status).toBe(404);
  });
});

describe('an expense in another currency, at the rate offered', () => {
  it('takes the rate offered when its rate is left out, and reads it back, counted at the offered rate', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000 },
        date: '2026-11-16',
        splitBetween: [ada.id, grace.id],
      },
      ada.token,
    );
    expect(answer.status).toBe(201);
    const read = await getExpense((answer.body as { id: string }).id, grace.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ amount: 950, original: { currency: 'CHF', amount: 1000, rate: '0.95' } });
  });

  it('takes a rate given within 2 % of the offered one, and refuses one beyond it, by the name of the rule', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const body = (rate: string) => ({
      description: 'Zurich dinner',
      original: { currency: 'CHF', amount: 1000, rate },
      date: '2026-11-16',
      splitBetween: [ada.id],
    });

    expect((await record(groupId, body('0.931'), ada.token)).status).toBe(201);
    expect((await record(groupId, body('0.969'), ada.token)).status).toBe(201);
    const outside = await record(groupId, body('0.93'), ada.token);
    expect(outside.status).toBe(400);
    expect(outside.body).toMatchObject({ type: 'RateOutsideBand' });
  });

  it('refuses an expense whose rate is left out, or given, when no rate is offered, by name', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const day = '2026-11-01';
    const left = await record(
      groupId,
      { description: 'Zurich dinner', original: { currency: 'CHF', amount: 1000 }, date: day, splitBetween: [ada.id] },
      ada.token,
    );
    expect(left.status).toBe(400);
    expect(left.body).toMatchObject({ type: 'NoRateOffered' });
    const given = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000, rate: '0.95' },
        date: day,
        splitBetween: [ada.id],
      },
      ada.token,
    );
    expect(given.status).toBe(400);
    expect(given.body).toMatchObject({ type: 'NoRateOffered' });
  });

  it('takes the payer’s rate as given when no rates service is configured (request 21), and refuses one left out', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    delete process.env.RATES_URL;

    const given = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000, rate: '0.5' },
        date: '2026-11-16',
        splitBetween: [ada.id],
      },
      ada.token,
    );
    expect(given.status).toBe(201);
    const left = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000 },
        date: '2026-11-16',
        splitBetween: [ada.id],
      },
      ada.token,
    );
    expect(left.status).toBe(400);
    expect(left.body).toMatchObject({ type: 'NoRateOffered' });
  });

  it('takes the offered rate on an edit that leaves its rate out, at the day the edit gives', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const created = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000, rate: '0.931' },
        date: '2026-11-16',
        splitBetween: [ada.id],
      },
      ada.token,
    );
    const { id } = created.body as { id: string };
    const { version } = (await getExpense(id, ada.token)).body as { version: number };

    const changed = await edit(
      id,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000 },
        date: '2026-11-16',
        splitBetween: [ada.id],
        version,
      },
      ada.token,
    );
    expect(changed.status).toBe(204);
    expect((await getExpense(id, ada.token)).body).toMatchObject({ amount: 950, original: { rate: '0.95' } });
  });

  it('refuses a body whose rate is given as something other than a string, by its shape', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const answer = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1000, rate: 0.95 },
        date: '2026-11-16',
        splitBetween: [ada.id],
      },
      ada.token,
    );
    expect(answer.status).toBe(400);
  });
});
