import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('original-settlements');

/**
 * The rates service and the payment provider, as servers of their own (request 39). The rates service answers the rate the test sets for a
 * pair, `404` for a pair it has none for; each rate asked for is recorded, with its day. The provider answers a link, with the fee the test
 * sets, and records each payment it is asked for, in the payment's own currency.
 */
let offers: Record<string, string>;
let rateRequests: string[];
let providerRequests: Array<{ reference: string; amount: number; currency: string; payee: string }>;
let providerFee: number;
let paymentCount: number;
let ratesServer: Server;
let providerServer: Server;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => resolve(text));
  });

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  ratesServer = createServer((request, response) => {
    rateRequests.push(request.url ?? '');
    const match = /^\/rates\/([^/?]+)\/([^/?]+)\?/.exec(request.url ?? '');
    const rate = match ? offers[`${match[1]}/${match[2]}`] : undefined;
    if (rate === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => ratesServer.listen(0, '127.0.0.1', () => resolve()));
  const ratesOrigin = `http://127.0.0.1:${(ratesServer.address() as AddressInfo).port}`;

  providerServer = createServer(async (request, response) => {
    const text = await readBody(request);
    if (request.method === 'POST' && request.url === '/payments') {
      providerRequests.push(JSON.parse(text));
      paymentCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `pay-${paymentCount}`,
          payUrl: `https://pay.example/pay-${paymentCount}`,
          fee: providerFee,
        }),
      );
      return;
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(request.url ?? '')) {
      const id = decodeURIComponent((request.url ?? '').slice('/accounts/'.length));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  process.env.RATES_URL = ratesOrigin;
  process.env.PROVIDER_URL = providerOrigin;
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => ratesServer.close(() => resolve()));
  await new Promise<void>(resolve => providerServer.close(() => resolve()));
  delete process.env.RATES_URL;
  delete process.env.PROVIDER_URL;
});
beforeEach(() => {
  offers = { 'CHF/EUR': '0.95' };
  rateRequests = [];
  providerRequests = [];
  providerFee = 100;
  paymentCount = 0;
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group in EUR with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
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

const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body;
const payCash = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });
const payThrough = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });
const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });

/** Ann paid 100 EUR for both of them: Bob owes Ann 50 EUR, that is 5000. */
async function annAndBobOwing50(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const groupId = await groupWith(ann, [bob]);
  // Ann is paid through the provider, so she has a payout account at it (request 16).
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    body: { accountId: `acct-${ann.id}` },
    token: ann.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Lodging', amount: 10000, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  return { ann, bob, groupId };
}

describe('a settlement paid in another currency (request 39)', () => {
  it('is paid in cash, recorded by its payee, at the rate offered on the day: it counts its amount in the group currency and keeps the rate it was decided at', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('cash-kept');

    const paid = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'CHF', amount: 4000 } });
    expect(paid.status).toBe(201);
    const id = (paid.body as { id: string }).id;

    // The rate was asked for CHF to EUR on the day it was decided, in UTC.
    expect(rateRequests.length).toBe(1);
    expect(rateRequests[0]).toMatch(/^\/rates\/CHF\/EUR\?date=\d{4}-\d{2}-\d{2}$/);

    const read = await readSettlement(id, ann.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      method: 'cash',
      status: 'paid',
      from: bob.id,
      to: ann.id,
      amount: 3800,
      original: { currency: 'CHF', amount: 4000, rate: '0.95' },
    });

    // The balances count 3800: 5000 less 3800 is what Bob still owes.
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 1200 },
      { memberId: bob.id, balance: -1200 },
    ]);

    // The rate the service offers later changes nothing about the settlement.
    offers = { 'CHF/EUR': '0.5' };
    expect((await readSettlement(id, ann.token)).body).toMatchObject({
      amount: 3800,
      original: { currency: 'CHF', amount: 4000, rate: '0.95' },
    });
  });

  it('is refused, and nothing is kept, when the rates service offers no rate for the pair', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('no-rate');

    const refused = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'USD', amount: 1000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 5000 },
      { memberId: bob.id, balance: -5000 },
    ]);
    const list = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(list.body).toEqual([]);
  });

  it('is refused for the wrong shape when it gives both an amount and an original, or neither', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('shape');
    const both = await payCash(groupId, ann.token, {
      from: bob.id,
      amount: 100,
      original: { currency: 'CHF', amount: 100 },
    });
    expect(both.status).toBe(400);
    const neither = await payCash(groupId, ann.token, { from: bob.id });
    expect(neither.status).toBe(400);
    const notAnInteger = await payCash(groupId, ann.token, {
      from: bob.id,
      original: { currency: 'CHF', amount: 1.5 },
    });
    expect(notAnInteger.status).toBe(400);
    expect(rateRequests).toEqual([]);
  });

  it('is refused by the rule for a currency that is not one of Tally, the currency of the group itself, or an amount out of range', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('rules');
    const unknown = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'XXX', amount: 100 } });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ type: 'UnknownCurrency' });

    const own = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'EUR', amount: 100 } });
    expect(own.status).toBe(422);
    expect(own.body).toMatchObject({ type: 'OriginalCurrencyIsGroupCurrency' });

    const none = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'CHF', amount: 0 } });
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ type: 'InvalidOriginalAmount' });
  });

  it('is refused when it is more than the payer still owes, once converted at the rate', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('debt');
    // 11 000 CHF at 0.95 is 10 450, more than the 5000 Bob owes Ann.
    const refused = await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'CHF', amount: 11000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'SettlementExceedsDebt' });
    // 5 000 CHF at 0.95 is 4 750, which is what Bob owes.
    expect(
      (await payCash(groupId, ann.token, { from: bob.id, original: { currency: 'CHF', amount: 5000 } })).status,
    ).toBe(201);
  });

  it('through the provider, asks for the payment in its currency, and converts the fee at the rate of the settlement', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('provider');
    // The provider takes 1 CHF of the 20 CHF it is asked for: 95 in the group's currency, at the rate, which the payee bears.
    providerFee = 100;
    const paid = await payThrough(groupId, bob.token, { to: ann.id, original: { currency: 'CHF', amount: 2000 } });
    expect(paid.status).toBe(201);
    const id = (paid.body as { id: string }).id;

    // The provider is asked for what is paid, in its currency.
    expect(providerRequests).toEqual([
      expect.objectContaining({ reference: id, amount: 2000, currency: 'CHF', payee: `acct-${ann.id}` }),
    ]);

    const read = await readSettlement(id, bob.token);
    expect(read.body).toMatchObject({
      method: 'provider',
      status: 'pending',
      amount: 1900,
      original: { currency: 'CHF', amount: 2000, rate: '0.95' },
      fee: { amount: 95, borneBy: 'payee' },
    });
    // Pending, it does not count yet: the balances are as they were.
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 5000 },
      { memberId: bob.id, balance: -5000 },
    ]);
  });

  it('through the provider, is refused before the provider is asked when no rate is offered', async () => {
    const { bob, ann, groupId } = await annAndBobOwing50('provider-no-rate');
    const refused = await payThrough(groupId, bob.token, { to: ann.id, original: { currency: 'USD', amount: 2000 } });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
    expect(providerRequests).toEqual([]);
  });
});
