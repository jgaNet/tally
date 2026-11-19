import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 22: the rate a rates service offers, which an expense in another currency takes when its rate is left out, and
 * which a stated rate must be within 2 % of. The group is in euros; the rates service is a stand-in that answers the rates
 * it is given (`offers`), and records what it was asked.
 */

const DEFAULT_OFFERS: Record<string, string> = {
  'USD/EUR': '0.95',
  'AUD/EUR': '0.6',
  'GBP/EUR': '0', // a service that answers a rate of 0 offers none
};

let offers: Record<string, string> = {};
let broken = new Set<string>();
let asked: { from: string; to: string; date: string | null }[] = [];
let rates: Server;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  rates = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://rates.test');
    const match = /^\/rates\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !match) {
      res.writeHead(404).end();
      return;
    }
    const from = decodeURIComponent(match[1]);
    const to = decodeURIComponent(match[2]);
    asked.push({ from, to, date: url.searchParams.get('date') });
    if (broken.has(from)) {
      res.writeHead(500).end();
      return;
    }
    const rate = offers[`${from}/${to}`];
    if (rate === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', () => resolve()));
  process.env.RATES_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'clock-offered-rates@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  rates.close();
});

beforeEach(() => {
  offers = { ...DEFAULT_OFFERS };
  broken = new Set();
  asked = [];
});

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-offered-rates-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in euros and answers its id, as a client does. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Lisbon week', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins, and the operation is followed. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** A group in euros: Alice (its owner) and Bob, who joined after her. */
async function twoMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  return { alice, bob, groupId };
}

/** Sends a command as a client does: the `202`, then the operation followed to its outcome. */
async function send(method: 'POST' | 'PUT', path: string, token: string | undefined, body: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** The day as the server reads it, so the spec reads no clock of its own. */
const today = () => serverToday;

const expenseOf = async (id: string, token: string) =>
  (await http.get(`${api}/expenses/${id}`, { token })).body as Body;

/** A query for the rate of `currency` to the group's, answered as a client reads it. */
const rateOf = (groupId: string, currency: string, token: string | undefined, date?: string) =>
  http.get(`${api}/groups/${groupId}/rates/${currency}${date ? `?date=${date}` : ''}`, { token });

describe('the rate offered', () => {
  it('offers the rate of a currency to the group’s on today, when no date is given', async () => {
    const { alice, groupId } = await twoMembers();
    const answer = await rateOf(groupId, 'USD', alice.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ currency: 'USD', date: today(), rate: '0.95' });
    expect(asked).toEqual([{ from: 'USD', to: 'EUR', date: today() }]);
  });

  it('offers the rate of the day it is given', async () => {
    const { alice, groupId } = await twoMembers();
    const answer = await rateOf(groupId, 'AUD', alice.token, '2026-03-02');
    expect(answer.body).toEqual({ currency: 'AUD', date: '2026-03-02', rate: '0.6' });
    expect(asked).toEqual([{ from: 'AUD', to: 'EUR', date: '2026-03-02' }]);
  });

  it.each([
    ['the group’s own currency', 'EUR'],
    ['a currency that is not Tally’s', 'XXX'],
    ['a currency with no rate offered', 'CAD'],
    ['a rate of 0', 'GBP'],
    ['a service that fails', 'AUD'],
  ])('answers 404 for %s', async (_, currency) => {
    const { alice, groupId } = await twoMembers();
    if (currency === 'AUD') broken.add('AUD');
    const answer = await rateOf(groupId, currency, alice.token);
    expect(answer.status).toBe(404);
  });

  it('answers 404 to someone who is not a member of the group', async () => {
    const { groupId } = await twoMembers();
    const carol = await person('Carol');
    expect((await rateOf(groupId, 'USD', carol.token)).status).toBe(404);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    const { groupId } = await twoMembers();
    expect((await rateOf(groupId, 'USD', undefined)).status).toBe(401);
  });

  it('answers 400 for a date that is not a day of the calendar', async () => {
    const { alice, groupId } = await twoMembers();
    expect((await rateOf(groupId, 'USD', alice.token, '2026-02-30')).status).toBe(400);
  });
});

describe('recording an expense at the rate offered', () => {
  it('takes the rate offered for its day when its rate is left out, and records it at that rate', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1000 },
      date: '2026-03-02',
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS', result: { rateSource: 'offered' } });
    expect(asked).toContainEqual({ from: 'USD', to: 'EUR', date: '2026-03-02' });

    const expense = await expenseOf((done as { result: { id: string } }).result.id, alice.token);
    expect(expense).toMatchObject({ amount: 950, original: { currency: 'USD', amount: 1000, rate: '0.95' } });
  });

  it.each([
    ['0.931', 931],
    ['0.95', 950],
    ['0.969', 969],
  ])('takes a stated rate of %s, within 2 %% of the offer', async (rate, amount) => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Within',
      original: { currency: 'USD', amount: 1000, rate },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS', result: { rateSource: 'checked' } });
    const expense = await expenseOf((done as { result: { id: string } }).result.id, alice.token);
    expect(expense).toMatchObject({ amount, original: { rate } });
  });

  it.each([
    ['0.93', 'RateOutsideBand'],
    ['0.97', 'RateOutsideBand'],
    ['1', 'RateOutsideBand'],
  ])('refuses a stated rate of %s, more than 2 %% from the offer, by name', async (rate, type) => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Outside',
      original: { currency: 'USD', amount: 1000, rate },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type } });
  });

  it('refuses an expense whose rate is left out when no rate is offered for its currency', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Nothing offered',
      original: { currency: 'CHF', amount: 1000 },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
  });

  it('refuses a stated rate when no rate is offered to compare it with', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Nothing to compare',
      original: { currency: 'CHF', amount: 1000, rate: '1.1' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
  });

  it('refuses a rate left out when the service fails, as when it offers none', async () => {
    const { alice, bob, groupId } = await twoMembers();
    broken.add('AUD');
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Service down',
      original: { currency: 'AUD', amount: 1000 },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
  });

  it('records a rate of 0 from the service as no rate offered', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Zero',
      original: { currency: 'GBP', amount: 1000 },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
  });

  it('does not ask the rates service for a group currency, which it does not convert', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'In euros',
      amount: 500,
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS', result: { rateSource: null } });
    expect(asked).toEqual([]);
  });
});

describe('editing an expense at the rate offered', () => {
  it('takes the rate offered on the day of the edit when its rate is left out', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1000 },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const before = await expenseOf(id, alice.token);
    expect(before).toMatchObject({ amount: 950 });

    offers['USD/EUR'] = '0.9';
    const edited = await send('PUT', `/expenses/${id}`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1000 },
      date: today(),
      version: before.version,
      splitBetween: [bob.id, alice.id],
    });
    expect(edited.done).toMatchObject({ status: 'SUCCESS', result: { rateSource: 'offered' } });
    expect(await expenseOf(id, alice.token)).toMatchObject({
      amount: 900,
      original: { currency: 'USD', amount: 1000, rate: '0.9' },
    });
  });

  it('refuses a stated rate outside the band when the expense is given again', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1000, rate: '0.95' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const before = await expenseOf(id, alice.token);

    const edited = await send('PUT', `/expenses/${id}`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1000, rate: '0.8' },
      date: today(),
      version: before.version,
      splitBetween: [bob.id, alice.id],
    });
    expect(edited.done).toMatchObject({ status: 'ERROR', error: { type: 'RateOutsideBand' } });
    expect(await expenseOf(id, alice.token)).toMatchObject({ amount: 950, original: { rate: '0.95' } });
  });
});
