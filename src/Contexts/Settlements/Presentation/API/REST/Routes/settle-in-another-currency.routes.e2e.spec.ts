import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider';

/**
 * Stand-ins for the two outside systems. The provider answers `201 { id, payUrl, fee }` to a payment, with the fee the test sets,
 * and keeps the last payment it was asked for. The rates service answers `200 { rate }` for a pair it offers, `404` otherwise,
 * and keeps the last request it was asked (request 39).
 */
let provider: Server;
let rates: Server;
let feeAnswer = 0;
let lastPayment: Record<string, unknown> | undefined;
let paymentCount = 0;
let offered: Record<string, string> = { 'CHF-EUR': '0.9542' };
let lastRateAsked: { pair: string; date: string } | undefined;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && /^\/accounts\/[^/]+$/.test(req.url ?? '')) {
        const accountId = decodeURIComponent((req.url ?? '').slice('/accounts/'.length));
        if (!accountId.startsWith('acct-')) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      paymentCount++;
      lastPayment = JSON.parse(data) as Record<string, unknown>;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `pay-${String(lastPayment.reference)}`,
          payUrl: `https://pay.example/${String(lastPayment.reference)}`,
          fee: feeAnswer,
        }),
      );
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));

  rates = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/rates\/([A-Z]{3})\/([A-Z]{3})$/.exec(url.pathname);
    if (req.method !== 'GET' || !match) {
      res.writeHead(404).end();
      return;
    }
    const pair = `${match[1]}-${match[2]}`;
    lastRateAsked = { pair, date: url.searchParams.get('date') ?? '' };
    const rate = offered[pair];
    if (rate === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', () => resolve()));

  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.RATES_URL = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'another-currency-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
  rates.close();
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
  const email = `another-currency-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in EUR and answers its id. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** The person sets the payout account the provider knows, and follows it to its outcome (request 16). */
async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** Sends the provider's webhook, signed as the provider signs it. */
async function webhook(payload: Body) {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': signature },
  });
}

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

/** Ann paid 60.00 for dinner, split with Bob: Bob owes Ann 30.00; Ann has a payout account at the provider. */
async function owing(name: string) {
  const ann = await person(`${name}Ann`);
  const bob = await person(`${name}Bob`);
  await setPayoutAccount(ann.token, 'acct-ann');
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 6000, date: serverToday, splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  await outcome((recorded.body as Body).operationId as string, ann.token);
  return { ann, bob, groupId };
}

describe('Settlements: a settlement paid in another currency (request 39)', () => {
  it('records a cash settlement in CHF at the rate offered for the day, and reads its original with the rate', async () => {
    const { ann, bob, groupId } = await owing('Cash');
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, original: { currency: 'CHF', amount: 2500 } },
      token: ann.token,
    });
    expect(answer.status).toBe(202);
    const done = await outcome((answer.body as Body).operationId as string, ann.token);
    expect((done.body as { status: string }).status).toBe('SUCCESS');
    const settlementId = (done.body as { result: { id: string } }).result.id;

    // The rate was asked of the service for CHF to EUR on the UTC day the settlement was decided.
    expect(lastRateAsked).toEqual({ pair: 'CHF-EUR', date: serverToday });

    const read = await http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      method: 'cash',
      status: 'paid',
      amount: 2386,
      original: { currency: 'CHF', amount: 2500, rate: '0.9542' },
    });
    // 25.00 CHF at 0.9542 is 23.855 EUR, a half rounded up: 2386 hundredths, which the balances count.
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 614, [bob.id]: -614 });
  });

  it('refuses a payment in a currency with no rate offered: nothing is kept, and the provider is not asked', async () => {
    const { ann, bob, groupId } = await owing('NoRate');
    const before = paymentCount;
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, original: { currency: 'USD', amount: 1000 } },
      token: bob.token,
    });
    expect(answer.status).toBe(202);
    const refused = await outcome((answer.body as Body).operationId as string, bob.token);
    expect((refused.body as { status: string }).status).toBe('ERROR');
    expect((refused.body as { error: { type: string } }).error.type).toBe('NoRateOffered');
    expect(paymentCount).toBe(before);
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 3000, [bob.id]: -3000 });
  });

  it('refuses a payment in the group currency, and a body that is neither or both of amount and original', async () => {
    const { ann, bob, groupId } = await owing('Shape');
    const same = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, original: { currency: 'EUR', amount: 2500 } },
      token: ann.token,
    });
    const sameDone = await outcome((same.body as Body).operationId as string, ann.token);
    expect((sameDone.body as { error: { type: string } }).error.type).toBe('SameCurrencyAsGroup');

    const both = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 100, original: { currency: 'CHF', amount: 2500 } },
      token: ann.token,
    });
    expect(both.status).toBe(400);
    const neither = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id },
      token: bob.token,
    });
    expect(neither.status).toBe(400);
  });

  it('pays through the provider in the currency paid, converts its fee, and keeps the rate when the rate moves', async () => {
    const { ann, bob, groupId } = await owing('Provider');
    feeAnswer = 100;
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, original: { currency: 'CHF', amount: 2500 } },
      token: bob.token,
    });
    const done = await outcome((answer.body as Body).operationId as string, bob.token);
    expect((done.body as { status: string }).status).toBe('SUCCESS');
    const settlementId = (done.body as { result: { id: string } }).result.id;

    // The provider is asked for what is paid: 2500 hundredths of francs, in CHF, to Ann's account.
    expect(lastPayment).toMatchObject({ amount: 2500, currency: 'CHF', payee: 'acct-ann', reference: settlementId });

    const pending = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(pending.body).toMatchObject({
      method: 'provider',
      status: 'pending',
      amount: 2386,
      // The provider's fee of 1.00 CHF is 0.95 EUR at the settlement's rate; borne by the payee, so the payer's share is none.
      fee: { amount: 95, borneBy: 'payee' },
      original: { currency: 'CHF', amount: 2500, rate: '0.9542' },
    });

    // The rate moves days later; the settlement keeps what was decided, and so does the payment the provider confirms.
    offered = { 'CHF-EUR': '1.2000' };
    const confirmed = await webhook({
      id: `evt-${settlementId}`,
      paymentId: `pay-${settlementId}`,
      status: 'succeeded',
      at: '2026-11-19T10:00:00.000Z',
    });
    expect(confirmed.status).toBe(202);
    const after = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(after.body).toMatchObject({
      status: 'paid',
      amount: 2386,
      original: { currency: 'CHF', amount: 2500, rate: '0.9542' },
    });
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 614, [bob.id]: -614 });
    offered = { 'CHF-EUR': '0.9542' };
  });
});
