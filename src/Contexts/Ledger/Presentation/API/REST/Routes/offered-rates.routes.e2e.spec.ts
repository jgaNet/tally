import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The rate Tally offers, end to end (request 22): the application booted in this process, spoken to over HTTP, every answer
 * held to api/22-offered-rates.yaml and api/21-another-currency.yaml by the client. The rates service is a fake one, a server
 * in this process; the application reads RATES_URL when a rate is asked, so an unset URL is a server with no service. The group
 * counts in EUR.
 */
const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** The rates the fake service offers, by `from/to`, on any day; a pair it does not have answers 404. */
let offers: Record<string, string> = {};
/** What the fake service does with a question: answers, fails with 500, or answers after the 5-second deadline. */
let mode: 'answer' | 'fail' | 'slow' = 'answer';
/** The questions the fake service was asked, in order, as `from/to?date=…`. */
let asked: string[] = [];

let ratesServer: Server;
let ratesUrl: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  ratesServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://rates.test');
    const [, , from, to] = url.pathname.split('/');
    asked.push(`${from}/${to}?date=${url.searchParams.get('date')}`);
    const answered = () => {
      if (mode === 'fail') return void res.writeHead(500).end();
      const rate = offers[`${from}/${to}`];
      if (rate === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rate }));
    };
    if (mode === 'slow') setTimeout(answered, 5500);
    else answered();
  });
  await new Promise<void>(resolve => ratesServer.listen(0, '127.0.0.1', resolve));
  ratesUrl = `http://127.0.0.1:${(ratesServer.address() as AddressInfo).port}`;

  process.env.RATES_URL = ratesUrl;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  delete process.env.RATES_URL;
  ratesServer.closeAllConnections();
  await new Promise(resolve => ratesServer.close(resolve));
});

beforeEach(() => {
  offers = { 'USD/EUR': '0.95', 'CHF/EUR': '1.02' };
  mode = 'answer';
  asked = [];
  process.env.RATES_URL = ratesUrl;
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function eurGroupOf(owner: { token: string }): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The week in Lyon', currency: 'EUR' },
    token: owner.token,
  });
  return (created.body as { id: string }).id;
}

const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token: string) => http.get(`/v1/expenses/${id}`, { token });
const editExpense = (id: string, token: string, body: unknown) =>
  http.request('PUT', `/v1/expenses/${id}`, { body, token });
const readRate = (groupId: string, currency: string, query: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/rates/${currency}${query}`, { token });

describe('Groups → Ledger → the rates service: the rate offered (request 22)', () => {
  it('answers the rate offered from a currency to the group’s, on the day asked, as the service gives it', async () => {
    const ana = await accountOf('ana.offered@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);

    const read = await readRate(groupId, 'USD', `?date=${SPENT}`, ana.token);
    expect(read).toMatchObject({ status: 200, body: { currency: 'USD', date: SPENT, rate: '0.95' } });
    expect(asked).toContain(`USD/EUR?date=${SPENT}`);
  });

  it('is the rate of today when the day is left out', async () => {
    const ana = await accountOf('ana.today@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);
    const answer = await readRate(groupId, 'CHF', '', ana.token);
    // The day is the server's, which says it in its own Date header: the test reads no clock of its own.
    const today = new Date(answer.headers.get('date') ?? '').toISOString().slice(0, 10);

    expect(answer).toMatchObject({ status: 200, body: { currency: 'CHF', date: today, rate: '1.02' } });
  });

  it('answers 404 for the group’s own currency, a currency Tally does not count in, a pair the service has no rate for, or a service that fails or is slow', async () => {
    const ana = await accountOf('ana.refusals@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);

    expect(await readRate(groupId, 'EUR', `?date=${SPENT}`, ana.token)).toMatchObject({ status: 404 });
    expect(await readRate(groupId, 'XYZ', `?date=${SPENT}`, ana.token)).toMatchObject({ status: 404 });
    expect(await readRate(groupId, 'GBP', `?date=${SPENT}`, ana.token)).toMatchObject({ status: 404 });
    mode = 'fail';
    expect(await readRate(groupId, 'USD', `?date=${SPENT}`, ana.token)).toMatchObject({ status: 404 });
  }, 15000);

  it('answers 404 when the service does not answer within 5 seconds', async () => {
    const ana = await accountOf('ana.slow@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);

    mode = 'slow';
    expect(await readRate(groupId, 'USD', `?date=${SPENT}`, ana.token)).toMatchObject({ status: 404 });
  }, 15000);

  it('answers 404 to a stranger, 401 to no one signed in, and 400 by name to a day the calendar does not have', async () => {
    const ana = await accountOf('ana.private@example.com', 'Ana');
    const bo = await accountOf('bo.private@example.com', 'Bo');
    const groupId = await eurGroupOf(ana);

    expect(await readRate(groupId, 'USD', `?date=${SPENT}`, bo.token)).toMatchObject({ status: 404 });
    expect(await readRate(groupId, 'USD', `?date=${SPENT}`)).toMatchObject({ status: 401 });
    expect(await readRate(groupId, 'USD', '?date=2020-02-30', ana.token)).toMatchObject({
      status: 400,
      body: { type: 'InvalidExpenseDate' },
    });
  });

  it('takes the offered rate when an expense in another currency leaves its rate out, and reads it back at the day of the expense', async () => {
    const ana = await accountOf('ana.takes@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);

    const recorded = await record(groupId, ana.token, {
      description: 'Dinner in Geneva',
      original: { currency: 'USD', amount: 1000 },
      date: SPENT,
      splitBetween: [ana.id],
    });
    expect(recorded.status).toBe(201);
    expect(asked).toContain(`USD/EUR?date=${SPENT}`);

    expect(await readExpense((recorded.body as { id: string }).id, ana.token)).toMatchObject({
      status: 200,
      body: { amount: 950, original: { currency: 'USD', amount: 1000, rate: '0.95' } },
    });
  });

  it('takes a stated rate within 2 % of the offered one, and refuses one more than 2 % away by its rule’s name (0.95 offered)', async () => {
    const ana = await accountOf('ana.band@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);
    const base = { description: 'Books', date: SPENT, splitBetween: [ana.id] };
    const at = (rate: string) =>
      record(groupId, ana.token, { ...base, original: { currency: 'USD', amount: 1000, rate } });

    expect((await at('0.931')).status).toBe(201);
    expect((await at('0.969')).status).toBe(201);
    const low = await at('0.93');
    const high = await at('0.97');
    expect(low).toMatchObject({ status: 400, body: { type: 'RateOutsideBand' } });
    expect(high).toMatchObject({ status: 400, body: { type: 'RateOutsideBand' } });
  });

  it('refuses by name a rate, stated or left out, when no rate is offered for its currency and day', async () => {
    const ana = await accountOf('ana.none@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);
    const base = { description: 'Tea', date: SPENT, splitBetween: [ana.id] };

    const leftOut = await record(groupId, ana.token, { ...base, original: { currency: 'GBP', amount: 500 } });
    const stated = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'GBP', amount: 500, rate: '1.1' },
    });
    expect(leftOut).toMatchObject({ status: 400, body: { type: 'NoRateOffered' } });
    expect(stated).toMatchObject({ status: 400, body: { type: 'NoRateOffered' } });

    mode = 'fail';
    const failing = await record(groupId, ana.token, { ...base, original: { currency: 'USD', amount: 500 } });
    expect(failing).toMatchObject({ status: 400, body: { type: 'NoRateOffered' } });
  });

  it('takes the payer’s rate, whatever it is, when no rates service is configured, and still refuses one left out', async () => {
    const ana = await accountOf('ana.unset@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);
    const base = { description: 'Tea', date: SPENT, splitBetween: [ana.id] };

    process.env.RATES_URL = '';
    const stated = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'GBP', amount: 500, rate: '1.1' },
    });
    const leftOut = await record(groupId, ana.token, { ...base, original: { currency: 'GBP', amount: 500 } });
    expect(stated.status).toBe(201);
    expect(asked).toHaveLength(0);
    expect(leftOut).toMatchObject({ status: 400, body: { type: 'NoRateOffered' } });
  });

  it('gives an edit that leaves the rate out the rate offered on its day, and refuses an edit outside the band by name', async () => {
    const ana = await accountOf('ana.edit@example.com', 'Ana');
    const groupId = await eurGroupOf(ana);
    const recorded = await record(groupId, ana.token, {
      description: 'Museum',
      original: { currency: 'USD', amount: 1000, rate: '0.931' },
      date: SPENT,
      splitBetween: [ana.id],
    });
    const id = (recorded.body as { id: string }).id;

    const outside = await editExpense(id, ana.token, {
      description: 'Museum',
      original: { currency: 'USD', amount: 2000, rate: '0.93' },
      date: SPENT,
      splitBetween: [ana.id],
      version: 1,
    });
    expect(outside).toMatchObject({ status: 400, body: { type: 'RateOutsideBand' } });

    const edited = await editExpense(id, ana.token, {
      description: 'Museum',
      original: { currency: 'USD', amount: 2000 },
      date: SPENT,
      splitBetween: [ana.id],
      version: 1,
    });
    expect(edited.status).toBe(201);
    expect(await readExpense(id, ana.token)).toMatchObject({
      status: 200,
      body: { amount: 1900, version: 2, original: { currency: 'USD', amount: 2000, rate: '0.95' } },
    });
  });
});
