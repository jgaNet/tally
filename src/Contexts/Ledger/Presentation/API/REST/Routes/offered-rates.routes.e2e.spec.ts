import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let service: Server;
let previousRatesUrl: string | undefined;

/** The rates the stand-in service offers, by `from/to/day`: a day without one is answered `404`. */
const offers = new Map<string, string>();
/** Whether the stand-in service fails to answer (`500`) instead of answering as its API says. */
let failing = false;
/** Whether the stand-in service offers the same rate on every day, which a read with no day given needs. */
let anyDay = false;
/** Every ask the service was given, in order: the currency it was asked from, the group's, and the day. */
const asked: Array<{ from: string; to: string; date: string | null }> = [];

const PAST_DAY = '2026-03-10';

beforeAll(async () => {
  // A stand-in for the rates service: it answers the rate of a currency to another on a day, the way its API says.
  service = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url as string, 'http://rates.test');
    const [, kind, from, to] = url.pathname.split('/');
    if (request.method !== 'GET' || kind !== 'rates') {
      response.writeHead(404).end();
      return;
    }
    const date = url.searchParams.get('date');
    asked.push({ from, to, date });
    if (failing) {
      response.writeHead(500).end();
      return;
    }
    const rate = anyDay ? '0.9' : offers.get(`${from}/${to}/${date}`);
    if (rate === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  previousRatesUrl = process.env.RATES_URL;
  process.env.RATES_URL = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  offers.set(`USD/EUR/${PAST_DAY}`, '0.95');
});

afterAll(async () => {
  if (previousRatesUrl === undefined) delete process.env.RATES_URL;
  else process.env.RATES_URL = previousRatesUrl;
  await app.stop();
  await new Promise(resolve => service.close(resolve));
});

beforeEach(() => {
  failing = false;
  anyDay = false;
  asked.length = 0;
});

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Expense = {
  id: string;
  amount: number;
  version: number;
  original?: { currency: string; amount: number; rate: string };
};

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** The accounts a file signs up share one database, so each one signed up here gets an address of its own. */
let accounts = 0;

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(address: string, name = 'Alice'): Promise<{ id: string; token: string }> {
  const email = address.replace('@', `+${++accounts}@`);
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group in euros and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** An expense paid in dollars, split between the two members given, the rate left out or stated. */
const dollars = (rate: string | undefined, members: string[], date = PAST_DAY) => ({
  description: 'Dinner',
  date,
  original: { currency: 'USD', amount: 1000, ...(rate === undefined ? {} : { rate }) },
  splitBetween: members,
});

async function record(token: string, groupId: string, body: object): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function readExpense(token: string, id: string): Promise<Expense> {
  return (await http.get(`${api}/expenses/${id}`, { token })).body as Expense;
}

describe('the rate offered (request 22)', () => {
  it('answers a member the rate offered from a currency to the group’s on a day, as the service gives it', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    const answer = await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`, { token: alice.token });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ currency: 'USD', date: PAST_DAY, rate: '0.95' });
    expect(asked).toContainEqual({ from: 'USD', to: 'EUR', date: PAST_DAY });
  });

  it('reads the day of today when no day is given: the day asked of the service is the day answered', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    anyDay = true;

    const answer = await http.get(`${api}/groups/${groupId}/rates/USD`, { token: alice.token });

    const day = asked[asked.length - 1]?.date as string;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(answer.body).toEqual({ currency: 'USD', date: day, rate: '0.9' });
  });

  it('answers 404 when no rate is offered, when the currency is the group’s or not Tally’s, and to anyone but a member', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const bob = await signedIn('bea@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Flat');

    expect((await http.get(`${api}/groups/${groupId}/rates/USD?date=2026-03-11`, { token: alice.token })).status).toBe(
      404,
    );
    expect((await http.get(`${api}/groups/${groupId}/rates/EUR?date=${PAST_DAY}`, { token: alice.token })).status).toBe(
      404,
    );
    expect((await http.get(`${api}/groups/${groupId}/rates/JPY?date=${PAST_DAY}`, { token: alice.token })).status).toBe(
      404,
    );
    expect((await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`, { token: bob.token })).status).toBe(
      404,
    );
    expect((await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`)).status).toBe(401);
  });

  it('answers 404 when the service does not answer as its API says, and 400 for a day that is not a real one', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    failing = true;
    expect((await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`, { token: alice.token })).status).toBe(
      404,
    );
    failing = false;
    expect((await http.get(`${api}/groups/${groupId}/rates/USD?date=2026-02-30`, { token: alice.token })).status).toBe(
      400,
    );
  });

  it('answers 404 without a rates service, and records an expense whose rate is left out is refused', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const saved = process.env.RATES_URL;
    delete process.env.RATES_URL;
    try {
      expect(
        (await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`, { token: alice.token })).status,
      ).toBe(404);
      const refused = await record(alice.token, groupId, dollars(undefined, [alice.id]));
      expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
    } finally {
      process.env.RATES_URL = saved;
    }
  });
});

describe('an expense in another currency takes or corrects the offered rate (request 22)', () => {
  it('takes the offered rate when its rate is left out, and records it at that rate', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    const recorded = await record(alice.token, groupId, dollars(undefined, [alice.id]));

    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    expect(await readExpense(alice.token, recorded.result as string)).toMatchObject({
      amount: 950,
      original: { currency: 'USD', amount: 1000, rate: '0.95' },
    });
  });

  it('takes a stated rate within 2 % of the offered one, and refuses one beyond it by the name of the rule', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    const within = await record(alice.token, groupId, dollars('0.931', [alice.id]));
    expect(within).toMatchObject({ status: 'SUCCESS' });
    expect(await readExpense(alice.token, within.result as string)).toMatchObject({
      amount: 931,
      original: { rate: '0.931' },
    });
    expect(await record(alice.token, groupId, dollars('0.969', [alice.id]))).toMatchObject({ status: 'SUCCESS' });

    const beyond = await record(alice.token, groupId, dollars('0.93', [alice.id]));
    expect(beyond).toMatchObject({ status: 'ERROR', error: { type: 'RateOutsideBand' } });
    expect(await record(alice.token, groupId, dollars('0.97', [alice.id]))).toMatchObject({
      status: 'ERROR',
      error: { type: 'RateOutsideBand' },
    });
  });

  it('refuses a stated rate when no rate is offered for its day, and a rate left out for the same reason', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    expect(await record(alice.token, groupId, dollars('0.95', [alice.id], '2026-03-11'))).toMatchObject({
      status: 'ERROR',
      error: { type: 'NoRateOffered' },
    });
    expect(await record(alice.token, groupId, dollars(undefined, [alice.id], '2026-03-11'))).toMatchObject({
      status: 'ERROR',
      error: { type: 'NoRateOffered' },
    });
  });

  it('refuses a day that is not a real one as a day, whatever the rate', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    expect(await record(alice.token, groupId, dollars(undefined, [alice.id], '2026-02-30'))).toMatchObject({
      status: 'ERROR',
      error: { type: 'InvalidDate' },
    });
  });

  it('keeps a stated rate as it is given when the server has no rates service, and refuses a rate left out', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const saved = process.env.RATES_URL;
    delete process.env.RATES_URL;
    try {
      const stated = await record(alice.token, groupId, dollars('3', [alice.id]));
      expect(stated).toMatchObject({ status: 'SUCCESS' });
      expect(await readExpense(alice.token, stated.result as string)).toMatchObject({
        amount: 3000,
        original: { rate: '3' },
      });
      expect(await record(alice.token, groupId, dollars(undefined, [alice.id]))).toMatchObject({
        status: 'ERROR',
        error: { type: 'NoRateOffered' },
      });
    } finally {
      process.env.RATES_URL = saved;
    }
  });

  it('settles an edit the same way: a rate left out is the offered one for the edit’s day, and a stated one is checked', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const recorded = await record(alice.token, groupId, dollars('0.95', [alice.id]));
    const expense = await readExpense(alice.token, recorded.result as string);

    const taken = await http.request('PUT', `${api}/expenses/${expense.id}`, {
      token: alice.token,
      body: { ...dollars(undefined, [alice.id]), version: expense.version },
    });
    expect(taken.status).toBe(202);
    const editOutcome = await outcome((taken.body as { operationId: string }).operationId, alice.token);
    expect(editOutcome).toMatchObject({ status: 'SUCCESS' });
    expect(await readExpense(alice.token, expense.id)).toMatchObject({
      original: { rate: '0.95' },
    });

    const beyond = await http.request('PUT', `${api}/expenses/${expense.id}`, {
      token: alice.token,
      body: { ...dollars('0.5', [alice.id]), version: expense.version + 1 },
    });
    expect(await outcome((beyond.body as { operationId: string }).operationId, alice.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'RateOutsideBand' },
    });
  });
});

describe('Groups → Ledger', () => {
  it('reads the rate of a group Groups made, and finds it by the id it answered, and records an expense in it', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    // Groups makes the group and answers its id; Ledger reads the group's currency through the port it owns, by that id.
    const groupId = await createGroup(alice.token, 'Made in Groups');

    const rate = await http.get(`${api}/groups/${groupId}/rates/USD?date=${PAST_DAY}`, { token: alice.token });
    expect(rate.body).toEqual({ currency: 'USD', date: PAST_DAY, rate: '0.95' });

    const recorded = await record(alice.token, groupId, dollars(undefined, [alice.id]));
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    expect(await readExpense(alice.token, recorded.result as string)).toMatchObject({
      amount: 950,
      original: { currency: 'USD', amount: 1000, rate: '0.95' },
    });
  });
});
