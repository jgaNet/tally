import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settling up in another currency, end to end (request 39): the application booted in this process, spoken to over HTTP, every
 * answer held to api/39-settle-in-another-currency.yaml by the client. Two fakes run in this process, started before the application
 * so that RATES_URL and PROVIDER_URL are the ones it reads: a rates service that offers 0.93 from CHF to EUR on any day and no rate
 * from USD, and a payment provider that answers a link with a fee of 100 hundredths of the payment's currency.
 */
const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** The rates the fake service was asked for, as the path and query it was sent. */
const ratesAsked: string[] = [];
/** The payments the fake provider was asked for, in order. */
const paymentsAsked: { reference: string; amount: number; currency: string; payee: string }[] = [];
let payments = 0;

function fake(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Server {
  return createServer((req, res) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => handler(req, res, text));
  });
}

const rates = fake((req, res) => {
  ratesAsked.push(req.url ?? '');
  if (req.url?.startsWith('/rates/CHF/EUR?date=')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ currency: 'CHF', rate: '0.93' }));
  }
  res.writeHead(404).end();
});

const provider = fake((req, res, text) => {
  if (req.method === 'POST' && req.url === '/payments') {
    const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
    paymentsAsked.push(body);
    payments += 1;
    res.writeHead(201, { 'content-type': 'application/json' });
    return void res.end(
      JSON.stringify({ id: `pay_${payments}`, payUrl: `https://provider.example/pay/pay_${payments}`, fee: 100 }),
    );
  }
  if (req.method === 'GET' && req.url?.startsWith('/accounts/')) {
    const accountId = decodeURIComponent(req.url.slice('/accounts/'.length));
    res.writeHead(accountId.startsWith('acct_') ? 200 : 404, { 'content-type': 'application/json' });
    return void res.end(accountId.startsWith('acct_') ? JSON.stringify({ id: accountId }) : '{}');
  }
  res.writeHead(404).end();
});

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.RATES_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(async () => {
  await app.stop();
  rates.close();
  provider.close();
  delete process.env.RATES_URL;
  delete process.env.PROVIDER_URL;
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group in euros with two members, where Ann paid 60.00 for both: Bob owes Ann 30.00. */
async function owing(
  tag: string,
): Promise<{ ann: { token: string; id: string }; bob: { token: string; id: string }; groupId: string }> {
  const ann = await accountOf(`ann.${tag}@example.com`, 'Ann');
  const bob = await accountOf(`bob.${tag}@example.com`, 'Bob');
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The trip', currency: 'EUR' },
    token: ann.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ann.token });
  expect(
    (
      await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: bob.token,
      })
    ).status,
  ).toBe(201);
  const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 6000, date: SPENT, splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  expect(expense.status).toBe(201);
  return { ann, bob, groupId };
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];
const settleCash = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body, token });
const payThrough = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/provider`, { body, token });

describe('a settlement in another currency (request 39)', () => {
  it('is paid in francs at the rate offered that day, counts its amount in euros, and reads its rate back', async () => {
    const { ann, bob, groupId } = await owing('cash-chf');
    // 32.26 CHF at 0.93 is 30.00 EUR: the whole of what Bob owes.
    const recorded = await settleCash(groupId, ann.token, {
      from: bob.id,
      original: { currency: 'CHF', amount: 3226 },
    });
    expect(recorded.status).toBe(201);
    const id = (recorded.body as { id: string }).id;

    // The rate is asked for the day it is decided, in UTC: the date is the one the settlement was decided on.
    expect(ratesAsked.some(path => /^\/rates\/CHF\/EUR\?date=\d{4}-\d{2}-\d{2}$/.test(path))).toBe(true);
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    const read = await http.get(`/v1/settlements/${id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id,
      amount: 3000,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 3226, rate: '0.93' },
    });
  });

  it('reads a settlement in the group currency without an original', async () => {
    const { ann, bob, groupId } = await owing('cash-eur');
    const recorded = await settleCash(groupId, ann.token, { from: bob.id, amount: 1000 });
    const id = (recorded.body as { id: string }).id;
    const read = await http.get(`/v1/settlements/${id}`, { token: bob.token });
    expect(read.body).not.toHaveProperty('original');
  });

  it('is refused when no rate is offered, and nothing is kept', async () => {
    const { ann, bob, groupId } = await owing('cash-usd');
    const refused = await settleCash(groupId, ann.token, { from: bob.id, original: { currency: 'USD', amount: 3000 } });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'NoRateOffered', message: expect.any(String) });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 3000 },
      { memberId: bob.id, balance: -3000 },
    ]);
  });

  it('names the currency or the amount it refuses, and an amount given both ways or neither is the wrong shape', async () => {
    const { ann, bob, groupId } = await owing('shape');
    const both = await settleCash(groupId, ann.token, {
      from: bob.id,
      amount: 1000,
      original: { currency: 'CHF', amount: 1000 },
    });
    expect(both.status).toBe(400);
    const neither = await settleCash(groupId, ann.token, { from: bob.id });
    expect(neither.status).toBe(400);

    const sameCurrency = await settleCash(groupId, ann.token, {
      from: bob.id,
      original: { currency: 'EUR', amount: 1000 },
    });
    expect(sameCurrency.body).toEqual({ type: 'InvalidOriginalCurrency', message: expect.any(String) });
    const tooMuch = await settleCash(groupId, ann.token, {
      from: bob.id,
      original: { currency: 'CHF', amount: 100_000_001 },
    });
    expect(tooMuch.body).toEqual({ type: 'InvalidOriginalAmount', message: expect.any(String) });
  });

  it('through the provider, asks the provider for the francs and converts its fee at the rate', async () => {
    const { ann, bob, groupId } = await owing('provider-chf');
    expect(
      (
        await http.request('PUT', '/v1/accounts/me/payout-account', {
          body: { accountId: 'acct_ann' },
          token: ann.token,
        })
      ).status,
    ).toBe(201);

    const asked = await payThrough(groupId, bob.token, { to: ann.id, original: { currency: 'CHF', amount: 3226 } });
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;

    expect(paymentsAsked[paymentsAsked.length - 1]).toEqual({
      reference: id,
      amount: 3226,
      currency: 'CHF',
      payee: 'acct_ann',
    });
    const read = await http.get(`/v1/settlements/${id}`, { token: bob.token });
    expect(read.body).toMatchObject({
      amount: 3000,
      method: 'provider',
      status: 'pending',
      // The provider's fee of 100 hundredths of a franc, at 0.93, is 93 hundredths of a euro (request 38: the payee bears it).
      fee: { amount: 93, borneBy: 'payee' },
      original: { currency: 'CHF', amount: 3226, rate: '0.93' },
    });
  });

  it('through the provider, when no rate is offered, asks the provider for nothing and keeps nothing', async () => {
    const { ann, bob, groupId } = await owing('provider-usd');
    await http.request('PUT', '/v1/accounts/me/payout-account', { body: { accountId: 'acct_ann' }, token: ann.token });
    const asked = paymentsAsked.length;

    const refused = await payThrough(groupId, bob.token, { to: ann.id, original: { currency: 'USD', amount: 3000 } });
    expect(refused.body).toEqual({ type: 'NoRateOffered', message: expect.any(String) });
    expect(paymentsAsked).toHaveLength(asked);
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 3000 },
      { memberId: bob.id, balance: -3000 },
    ]);
  });
});
