import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'provider-test-secret';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
/** Every payment link the provider gave, in the order it gave them: the payment's id there, and the settlement it is for. */
const issued: Array<{ paymentId: string; reference: string; amount: number; currency: string }> = [];
let refusing = false;
let previousEnv: { url?: string; secret?: string };

beforeAll(async () => {
  // A stand-in for the provider: it answers the payment link the way its API says, and records what it was asked.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (refusing) {
        response.writeHead(500).end();
        return;
      }
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string };
      const paymentId = `pay_${issued.length + 1}`;
      issued.push({ paymentId, ...body });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, payUrl: `https://pay.example/${paymentId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousEnv = { url: process.env.PROVIDER_URL, secret: process.env.PROVIDER_WEBHOOK_SECRET };
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
  restoreEnv('PROVIDER_URL', previousEnv.url);
  restoreEnv('PROVIDER_WEBHOOK_SECRET', previousEnv.secret);
});

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

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

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name = 'Alice'): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Asks to pay another member through the provider, and follows the operation of the request. */
async function payThroughProvider(token: string, groupId: string, body: { to: string; amount: number }) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** The provider's webhook: the body as it is sent, signed with the secret it shares with Tally, unless a signature is given. */
async function webhook(body: object, signature?: string) {
  const text = JSON.stringify(body);
  const expected = createHmac('sha256', SECRET).update(text).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signature ?? expected },
  });
}

async function balances(token: string, groupId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/balances`, { token });
}

async function suggested(token: string, groupId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/settlements/suggested`, { token });
}

/** The payment the provider last gave a link for. */
const lastPayment = () => issued[issued.length - 1];

const PAST_DAY = '2026-03-10';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

/** Ann paid 60 for dinner, split between Ann and Bob: Ann is owed 30, Bob owes 30. */
async function dinnerGroup(prefix: string) {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${prefix}-bob@example.com`, 'Bob');
  const groupId = await createGroup(ann.token, 'Provider');
  await join(ann.token, groupId, bob.token);
  expect(
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    }),
  ).toMatchObject({ status: 'SUCCESS' });
  return { ann, bob, groupId };
}

describe('pay through the provider (request 13)', () => {
  it('asks the provider for a link, keeps the payment pending and counts it as paid for what is owed, and settles when the signed webhook says it succeeded', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp1');

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;
    const { paymentId } = lastPayment();
    expect(lastPayment()).toEqual({ paymentId, reference: settlementId, amount: 30, currency: 'EUR' });

    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      status: 200,
      body: {
        id: settlementId,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 30,
        method: 'provider',
        status: 'pending',
        payUrl: `https://pay.example/${paymentId}`,
        at: expect.stringMatching(ISO_TIME),
      },
    });
    // Not counted in the balances until it is paid, but already counted in what is still owed.
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });
    expect(await suggested(bob.token, groupId)).toMatchObject({ status: 200, body: [] });
    expect(await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'ExceedsWhatIsOwed' },
    });

    // An unsigned webhook, and one with a wrong signature, are refused and change nothing.
    const body = { id: 'wh_1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' };
    expect(await webhook(body, '')).toMatchObject({ status: 401 });
    expect(await webhook(body, 'ab'.repeat(32))).toMatchObject({ status: 401 });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'pending' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({ body: [{ balance: 30 }, { balance: -30 }] });

    // The signed webhook says it succeeded: the settlement is paid and the balances count it.
    expect(await webhook(body)).toMatchObject({ status: 202 });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'paid' },
    });
    expect(await balances(bob.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });

  it('frees what a failed payment held, changes nothing for a payment it does not know, and ignores a webhook that comes after the status is decided', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp2');

    const first = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const firstPayment = lastPayment().paymentId;
    const settlement = () => http.get(`${api}/settlements/${first}`, { token: bob.token });

    expect(
      await webhook({ id: 'wh_2', paymentId: 'pay_unknown', status: 'succeeded', at: '2026-11-17T10:00:00Z' }),
    ).toMatchObject({ status: 202 });
    expect(await settlement()).toMatchObject({ body: { status: 'pending' } });
    expect(
      await webhook({ id: 'wh_3', paymentId: firstPayment, status: 'pending', at: '2026-11-17T10:00:30Z' }),
    ).toMatchObject({
      status: 202,
    });
    expect(await settlement()).toMatchObject({ body: { status: 'pending' } });

    expect(
      await webhook({ id: 'wh_4', paymentId: firstPayment, status: 'failed', at: '2026-11-17T10:01:00Z' }),
    ).toMatchObject({ status: 202 });
    expect(await settlement()).toMatchObject({ body: { status: 'failed', method: 'provider' } });
    expect(await balances(ann.token, groupId)).toMatchObject({ body: [{ balance: 30 }, { balance: -30 }] });
    expect(await suggested(bob.token, groupId)).toMatchObject({ body: [{ from: bob.id, to: ann.id, amount: 30 }] });

    // What the failed payment held is free: the same amount can be asked again, and a later "succeeded" for the failed one is ignored.
    const again = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    expect(again).toEqual(expect.any(String));
    expect(again).not.toBe(first);
    expect(
      await webhook({ id: 'wh_5', paymentId: firstPayment, status: 'succeeded', at: '2026-11-17T10:03:00Z' }),
    ).toMatchObject({ status: 202 });
    expect(await settlement()).toMatchObject({ body: { status: 'failed' } });
    expect(await http.get(`${api}/settlements/${again}`, { token: bob.token })).toMatchObject({
      body: { status: 'pending' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({ body: [{ balance: 30 }, { balance: -30 }] });
  });

  it('keeps nothing when the provider gives no link, and refuses a payment without a provider URL', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp3');
    const before = issued.length;

    refusing = true;
    try {
      expect(await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).toMatchObject({
        status: 'ERROR',
        error: { type: 'ProviderUnavailable' },
      });
    } finally {
      refusing = false;
    }
    expect(await suggested(bob.token, groupId)).toMatchObject({ body: [{ from: bob.id, to: ann.id, amount: 30 }] });

    const url = process.env.PROVIDER_URL;
    delete process.env.PROVIDER_URL;
    try {
      expect(await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).toMatchObject({
        status: 'ERROR',
        error: { type: 'ProviderUnavailable' },
      });
    } finally {
      restoreEnv('PROVIDER_URL', url);
    }
    expect(issued).toHaveLength(before);
  });

  it('refuses a payment to a non-member, a payment to oneself and an anonymous caller', async () => {
    const { ann, bob, groupId } = await dinnerGroup('pp4');
    const stranger = await signedIn('pp4-stranger@example.com', 'Stranger');

    expect(await payThroughProvider(bob.token, groupId, { to: stranger.id, amount: 1 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'PayeeNotAMember' },
    });
    expect(await payThroughProvider(bob.token, groupId, { to: bob.id, amount: 1 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'PaidToSelf' },
    });
    expect(await payThroughProvider(stranger.token, groupId, { to: ann.id, amount: 1 })).toMatchObject({
      status: 'ERROR',
    });
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body: { to: ann.id, amount: 1 } }),
    ).toMatchObject({ status: 401 });
  });
});

describe('Groups → Settlements (request 13)', () => {
  it("makes the group through Groups, keeps the id its creation answered, asks the provider for a payment in that group's currency, and finds the settlement by the id its request answered", async () => {
    const ann = await signedIn('g13-ann@example.com', 'Ann');
    const bob = await signedIn('g13-bob@example.com', 'Bob');
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Dollars', currency: 'USD' },
    });
    const groupId = (await outcome((created.body as { operationId: string }).operationId, ann.token)).result as string;
    await join(ann.token, groupId, bob.token);
    expect(
      await record(ann.token, groupId, {
        description: 'Lunch',
        amount: 40,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 20 });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;
    expect(lastPayment()).toMatchObject({ reference: settlementId, amount: 20, currency: 'USD' });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).toMatchObject({
      status: 200,
      body: { id: settlementId, groupId, method: 'provider', status: 'pending' },
    });
  });
});

describe('Ledger → Settlements (request 13)', () => {
  it('keeps the id an expense request answered, counts a payment through the provider in the balances only once the signed webhook says it succeeded, and finds the settlement by the id its request answered', async () => {
    const ann = await signedIn('l13-ann@example.com', 'Ann');
    const bob = await signedIn('l13-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Ledger');
    await join(ann.token, groupId, bob.token);
    const expense = await record(ann.token, groupId, {
      description: 'Taxi',
      amount: 50,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    const expenseId = expense.result as string;
    expect(await http.get(`${api}/expenses/${expenseId}`, { token: ann.token })).toMatchObject({
      status: 200,
      body: { id: expenseId, groupId },
    });

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 25 });
    const settlementId = paid.result as string;
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 25 },
        { memberId: bob.id, balance: -25 },
      ],
    });

    const body = { id: 'wh_l13', paymentId: lastPayment().paymentId, status: 'succeeded', at: '2026-11-17T12:00:00Z' };
    expect(await webhook(body)).toMatchObject({ status: 202 });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { id: settlementId, status: 'paid' },
    });
  });
});
