import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let rates: Server;
let provider: Server;
let previousEnv: { rates?: string; provider?: string };

/** The rate the rates service offers for every day, by `from/to`; a pair without one is answered `404`. */
const offers = new Map<string, string>();
/** Every ask the rates service was given, in order: the currency asked from, the group's, and the day. */
const asked: Array<{ from: string; to: string; date: string | null }> = [];
/** Every payment the provider was asked for, in order, and the fee it answers with, in the payment's currency. */
const issued: Array<{ reference: string; amount: number; currency: string; payee: string }> = [];
let providerFee = 0;

const PAST_DAY = '2026-03-10';

beforeAll(async () => {
  // Stand-ins for the rates service and the provider, each answering its API the way it says.
  rates = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url as string, 'http://rates.test');
    const [, kind, from, to] = url.pathname.split('/');
    const date = url.searchParams.get('date');
    if (request.method !== 'GET' || kind !== 'rates') {
      response.writeHead(404).end();
      return;
    }
    asked.push({ from, to, date });
    const rate = offers.get(`${from}/${to}`);
    if (rate === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rate }));
  });
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.url?.startsWith('/accounts/') && request.method === 'GET') {
        // A payout account the provider knows: its id is the account's, as the stand-in was given it.
        const accountId = decodeURIComponent((request.url as string).split('/')[2]);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (request.url?.endsWith('/payments') && request.method === 'POST') {
        const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
        const paymentId = `pay_${issued.length + 1}`;
        issued.push(body);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: paymentId, fee: providerFee, payUrl: `https://pay.example/${paymentId}` }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousEnv = { rates: process.env.RATES_URL, provider: process.env.PROVIDER_URL };
  process.env.RATES_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(async () => {
  await app.stop();
  await new Promise(resolve => rates.close(resolve));
  await new Promise(resolve => provider.close(resolve));
  restoreEnv('RATES_URL', previousEnv.rates);
  restoreEnv('PROVIDER_URL', previousEnv.provider);
});

beforeEach(() => {
  offers.clear();
  asked.length = 0;
  issued.length = 0;
  providerFee = 0;
});

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Settlement = {
  id: string;
  at: string;
  amount: number;
  method: string;
  status: string;
  original?: { currency: string; amount: number; rate: string };
  fee?: { amount: number; borneBy: string };
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

/** Signs someone up and in, and sets the payout account the provider knows for them, so that they can be paid through it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  const person = { id: operation.result as string, token: (login.body as { token: string }).token };
  await http
    .request('PUT', `${api}/accounts/me/payout-account`, {
      token: person.token,
      body: { accountId: `payout_${person.id}` },
    })
    .then(answer => outcome((answer.body as { operationId: string }).operationId, person.token));
  return person;
}

/** A group in euros, Ann and Bob in it, and Ann paid 60.00 for dinner split between them: Bob owes Ann 30.00. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  const groupId = (await outcome((created.body as { operationId: string }).operationId, ann.token)).result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: bob.token });
  await outcome((accepted.body as { operationId: string }).operationId, bob.token);
  const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Dinner', amount: 6000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
  });
  expect(await outcome((expense.body as { operationId: string }).operationId, ann.token)).toMatchObject({
    status: 'SUCCESS',
  });
  return { ann, bob, groupId };
}

/** The result of an operation that succeeded: the settlement's id. */
async function succeeded(answer: Promise<Operation | { status: number }>): Promise<unknown> {
  const operation = await answer;
  expect(operation).toMatchObject({ status: 'SUCCESS' });
  return (operation as Operation).result;
}

/** Records a payment in cash from `from` to the caller, with the body given, and follows the operation. */
async function recordCash(token: string, groupId: string, body: object): Promise<Operation | { status: number }> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token, body });
  if (answer.status !== 202) return { status: answer.status };
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Asks to pay another member through the provider with the body given, and follows the operation. */
async function payThroughProvider(
  token: string,
  groupId: string,
  body: object,
): Promise<Operation | { status: number }> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token, body });
  if (answer.status !== 202) return { status: answer.status };
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function settlementOf(token: string, id: string): Promise<Settlement> {
  const answer = await http.get(`${api}/settlements/${id}`, { token });
  expect(answer.status).toBe(200);
  return answer.body as Settlement;
}

async function balancesOf(token: string, groupId: string): Promise<Array<{ memberId: string; balance: number }>> {
  const answer = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return answer.body as Array<{ memberId: string; balance: number }>;
}

describe('Settlement in another currency (request 39)', () => {
  it('records a cash settlement in another currency at the rate offered that day, and keeps it', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc1');
    offers.set('CHF/EUR', '0.95');

    const recorded = await recordCash(ann.token, groupId, {
      from: bob.id,
      original: { currency: 'CHF', amount: 3000 },
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    const id = (recorded as Operation).result as string;
    // The rate is asked for the day the settlement is decided, in UTC: the day it was recorded on (the same instant).
    expect(asked.at(-1)).toEqual({ from: 'CHF', to: 'EUR', date: (await settlementOf(ann.token, id)).at.slice(0, 10) });

    // CHF 30.00 at 0.95 is EUR 28.50: what Bob owed Ann is 30.00, so 28.50 is what is settled.
    expect(await settlementOf(ann.token, id)).toMatchObject({
      method: 'cash',
      status: 'paid',
      amount: 2850,
      original: { currency: 'CHF', amount: 3000, rate: '0.95' },
    });
    expect(await balancesOf(ann.token, groupId)).toEqual([
      { memberId: ann.id, balance: 150 },
      { memberId: bob.id, balance: -150 },
    ]);
  });

  it('keeps the rate it was decided at, whatever the rates service offers later', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc2');
    offers.set('CHF/EUR', '0.95');
    const id = (await succeeded(
      recordCash(ann.token, groupId, { from: bob.id, original: { currency: 'CHF', amount: 3000 } }),
    )) as string;

    offers.set('CHF/EUR', '0.50');
    expect(await settlementOf(bob.token, id)).toMatchObject({
      amount: 2850,
      original: { currency: 'CHF', amount: 3000, rate: '0.95' },
    });
  });

  it('refuses a settlement when the rates service offers no rate, and keeps nothing', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc3');

    expect(
      await recordCash(ann.token, groupId, { from: bob.id, original: { currency: 'CHF', amount: 3000 } }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
    expect(await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token })).toMatchObject({
      status: 200,
      body: [],
    });
  });

  it('refuses a payment in the group’s own currency, or in a currency Tally does not count in', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc4');
    offers.set('CHF/EUR', '0.95');

    expect(
      await recordCash(ann.token, groupId, { from: bob.id, original: { currency: 'EUR', amount: 100 } }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'SameCurrencyAsTheGroup' } });
    expect(
      await recordCash(ann.token, groupId, { from: bob.id, original: { currency: 'XXX', amount: 100 } }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'InvalidOriginalCurrency' } });
    expect(
      await recordCash(ann.token, groupId, { from: bob.id, original: { currency: 'CHF', amount: 0 } }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'InvalidOriginalAmount' } });
    expect(asked.some(ask => ask.from === 'EUR' || ask.from === 'XXX')).toBe(false);
  });

  it('answers a body with both ways to give the money, or with neither, as a wrong shape (400)', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc5');

    const both = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 100, original: { currency: 'CHF', amount: 100 } },
    });
    const neither = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id },
    });
    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
  });

  it('pays through the provider in another currency: the provider is asked for the original, and the fee is converted', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp1');
    offers.set('USD/EUR', '1.10');
    providerFee = 101;

    const started = await payThroughProvider(bob.token, groupId, {
      to: ann.id,
      original: { currency: 'USD', amount: 2000 },
    });
    expect(started).toMatchObject({ status: 'SUCCESS' });
    expect(issued.at(-1)).toMatchObject({ amount: 2000, currency: 'USD', payee: `payout_${ann.id}` });

    // USD 20.00 at 1.10 is EUR 22.00, and the provider's fee of USD 1.01 is EUR 1.11 (1.111, to the nearest), borne by the payee.
    expect(await settlementOf(bob.token, (started as Operation).result as string)).toMatchObject({
      method: 'provider',
      status: 'pending',
      amount: 2200,
      original: { currency: 'USD', amount: 2000, rate: '1.10' },
      fee: { amount: 111, borneBy: 'payee' },
    });
  });

  it('refuses a payment through the provider with no rate offered, and does not ask the provider', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp2');

    expect(
      await payThroughProvider(bob.token, groupId, { to: ann.id, original: { currency: 'USD', amount: 2000 } }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
    expect(issued).toHaveLength(0);
  });

  it('reads a settlement in the group’s currency as before, with no original', async () => {
    const { ann, bob, groupId } = await dinnerGroup('sc6');
    const id = (await succeeded(recordCash(ann.token, groupId, { from: bob.id, amount: 1000 }))) as string;

    const settlement = await settlementOf(ann.token, id);
    expect(settlement).toMatchObject({ amount: 1000, method: 'cash' });
    expect(settlement).not.toHaveProperty('original');
    expect(asked).toHaveLength(0);
  });
});
