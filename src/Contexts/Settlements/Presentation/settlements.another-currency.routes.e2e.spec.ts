import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A settlement paid in another currency, over HTTP (request 39, fragment 39): decided at the rate the rates service offers on the day, in
 * UTC, and kept on it, so a rate the service later offers counts nothing; counted in the group's currency by the balances; refused by name
 * when no rate is offered, and the provider is then not asked; and through the provider, asked for the amount and currency paid, with its
 * fee converted at the same rate. The fake rates service and the fake provider answer what each test sets.
 */
let directory: string;
let rates: Server;
/** The rate the fake rates service offers per `FROM/TO`, or none when it offers none. */
let offered: Map<string, string>;
let rateRequests: { from: string; to: string; date: string }[];
let provider: Server;
/** The fee the fake provider keeps, in the payment's currency's hundredths. */
let providerFee: number;
let providerRequests: { reference: string; amount: number; currency: string; payee: string }[];
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let webhooks: number;

const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-another-currency-settlements-'));
  const databaseUrl = await freshDatabase();

  rates = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/rates\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const [from, to] = [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
    rateRequests.push({ from, to, date: url.searchParams.get('date') ?? '' });
    const rate = offered.get(`${from}/${to}`);
    res.statusCode = rate === undefined ? 404 : 200;
    res.setHeader('content-type', 'application/json');
    res.end(rate === undefined ? '{}' : JSON.stringify({ rate }));
  });
  await listen(rates);

  nextPayment = 0;
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const known = decodeURIComponent(account[1]).startsWith('acct-');
      res.statusCode = known ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(known ? JSON.stringify({ id: decodeURIComponent(account[1]) }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
      providerRequests.push(body);
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: providerFee }));
    });
  });
  await listen(provider);

  app = await createApplication({
    databaseUrl,
    logger: silent,
    providerUrl: urlOf(provider),
    providerWebhookSecret: SECRET,
    ratesUrl: urlOf(rates),
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
});

beforeEach(() => {
  offered = new Map([
    ['CHF/EUR', '1.0625'],
    ['USD/EUR', '0.9'],
  ]);
  rateRequests = [];
  providerFee = 0;
  providerRequests = [];
  webhooks = 0;
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  rates.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await new Promise(resolve => rates.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token,
    body: { accountId: `acct-${name.toLowerCase()}` },
  });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;

/** A group in euros with Ann and Bob in it, where Ann paid 2000 for both: Bob owes Ann 1000 (100000 hundredths). */
const groupWithDebt = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Hotel', amount: 200000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
  });
  return groupId;
};

const cash = (groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token: ann.token, body });
const viaProvider = (groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token: bob.token, body });
const read = (id: string) => http.request('GET', `${api}/settlements/${id}`, { token: ann.token });
const balances = async (groupId: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
    memberId: string;
    balance: number;
  }[];
const owedBy = async (groupId: string, who: string) =>
  (await balances(groupId)).find(row => row.memberId === who)?.balance;

const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });
};

describe('a settlement in cash in another currency (request 39)', () => {
  it('is decided at the rate offered on the day, counts its amount in the group’s currency, and keeps the original and the rate', async () => {
    const groupId = await groupWithDebt();
    const recorded = await cash(groupId, { from: bob.id, original: { currency: 'CHF', amount: 80000 } });
    expect(recorded.status).toBe(201);
    const { id } = recorded.body as { id: string };

    const { status, body } = await read(id);
    expect(status).toBe(200);
    // The rate is asked for the day the settlement was decided on, in UTC: the day of its own time, which Tally stamped.
    expect(rateRequests).toEqual([{ from: 'CHF', to: 'EUR', date: (body as { at: string }).at.slice(0, 10) }]);
    expect(body).toMatchObject({
      from: bob.id,
      to: ann.id,
      amount: 85000,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 80000, rate: '1.0625' },
    });
    expect(await owedBy(groupId, bob.id)).toBe(-15000);
  });

  it('keeps the rate it was decided at, when the service later offers another', async () => {
    const groupId = await groupWithDebt();
    const { id } = (await cash(groupId, { from: bob.id, original: { currency: 'CHF', amount: 80000 } })).body as {
      id: string;
    };

    offered.set('CHF/EUR', '2.5');
    const { body } = await read(id);
    expect(body).toMatchObject({ amount: 85000, original: { currency: 'CHF', amount: 80000, rate: '1.0625' } });
    expect(await owedBy(groupId, bob.id)).toBe(-15000);
  });

  it('is refused by name with no rate offered, and nothing is kept', async () => {
    const groupId = await groupWithDebt();
    offered.delete('CHF/EUR');
    const refused = await cash(groupId, { from: bob.id, original: { currency: 'CHF', amount: 80000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'NoRateOffered', message: expect.any(String) });
    expect(await owedBy(groupId, bob.id)).toBe(-100000);
    const { body } = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(body).toEqual([]);
  });

  it('refuses a converted amount more than the payer owes, by the rules of a settlement', async () => {
    const groupId = await groupWithDebt();
    const refused = await cash(groupId, { from: bob.id, original: { currency: 'CHF', amount: 100000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'MoreThanPayerOwes', message: expect.any(String) });
    expect(await owedBy(groupId, bob.id)).toBe(-100000);
  });

  it.each([
    [
      'a body with both an amount and an original',
      { from: 'x', amount: 100, original: { currency: 'CHF', amount: 100 } },
    ],
    ['a body with neither', { from: 'x' }],
  ])('answers %s with 400, before anything runs', async (_label, body) => {
    const groupId = await groupWithDebt();
    const refused = await cash(groupId, body);
    expect(refused.status).toBe(400);
  });

  it.each([
    ['a currency Tally does not know', { currency: 'JPY', amount: 100 }, 'InvalidOriginalCurrency'],
    ['the group’s own currency', { currency: 'EUR', amount: 100 }, 'OriginalCurrencyIsGroupCurrency'],
    ['an amount of 0', { currency: 'CHF', amount: 0 }, 'InvalidOriginalAmount'],
  ])('refuses %s with 422 naming the rule', async (_label, original, type) => {
    const groupId = await groupWithDebt();
    const refused = await cash(groupId, { from: bob.id, original });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type, message: expect.any(String) });
  });
});

describe('a settlement through the provider in another currency (request 39)', () => {
  it('asks the provider for the amount and currency paid, converts its fee at the rate, and counts what was decided when it succeeds later', async () => {
    const groupId = await groupWithDebt();
    providerFee = 1000;
    const requested = await viaProvider(groupId, { to: ann.id, original: { currency: 'USD', amount: 50000 } });
    expect(requested.status).toBe(201);
    const { id } = requested.body as { id: string };

    expect(providerRequests).toEqual([{ reference: id, amount: 50000, currency: 'USD', payee: 'acct-ann' }]);
    const pending = await read(id);
    expect(pending.body).toMatchObject({
      amount: 45000,
      status: 'pending',
      original: { currency: 'USD', amount: 50000, rate: '0.9' },
      fee: { amount: 900, borneBy: 'payee' },
    });
    expect(rateRequests).toEqual([{ from: 'USD', to: 'EUR', date: (pending.body as { at: string }).at.slice(0, 10) }]);
    expect(await owedBy(groupId, bob.id)).toBe(-100000);

    offered.set('USD/EUR', '3');
    expect((await webhook('pay-1', 'succeeded')).status).toBe(204);
    const paid = await read(id);
    expect(paid.body).toMatchObject({ amount: 45000, status: 'paid', original: { rate: '0.9' } });
    expect(await owedBy(groupId, bob.id)).toBe(-55000);
  });

  it('is refused by name with no rate offered, and the provider is not asked', async () => {
    const groupId = await groupWithDebt();
    offered.delete('USD/EUR');
    const refused = await viaProvider(groupId, { to: ann.id, original: { currency: 'USD', amount: 50000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'NoRateOffered', message: expect.any(String) });
    expect(providerRequests).toEqual([]);
  });
});
