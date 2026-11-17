import { createHmac } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';

import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'provider-test-secret';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
/** Every payment link the provider gave, in the order it gave them: the payment's id there, and the settlement it is for. */
const issued: Array<{ paymentId: string; reference: string; amount: number; currency: string; payee: string }> = [];
let refusing = false;
/** Every refund the provider was asked for, in the order it was asked: the payment, and the settlement it is for. */
const refunded: Array<{ paymentId: string; reference: string }> = [];
let refusingRefunds = false;
/** The payout accounts the provider does not know: asked for, it answers `404`. */
const unknownAccounts = new Set<string>();
/** Whether the provider refuses to answer about payout accounts at all (`500`). */
let refusingAccounts = false;
let previousEnv: { url?: string; secret?: string };

beforeAll(async () => {
  // A stand-in for the provider: it answers the payment link the way its API says, and records what it was asked.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        const accountId = decodeURIComponent(request.url.slice('/accounts/'.length));
        if (refusingAccounts) {
          response.writeHead(500).end();
          return;
        }
        if (unknownAccounts.has(accountId)) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (request.url?.endsWith('/refunds')) {
        const { reference } = JSON.parse(text) as { reference: string };
        if (refusingRefunds) {
          response.writeHead(500).end();
          return;
        }
        refunded.push({ paymentId: (request.url as string).split('/')[2], reference });
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `refund_${refunded.length}` }));
        return;
      }
      if (refusing) {
        response.writeHead(500).end();
        return;
      }
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string; payee: string };
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

/** The provider's id for a person's payout account, which the provider knows: the person's account id, prefixed. */
const payoutOf = (accountId: string) => `payout_${accountId}`;

/** Sets the caller's payout account, and follows the operation of the request. */
async function setPayoutAccount(token: string, accountId: string): Promise<Operation> {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { token, body: { accountId } });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/**
 * Signs someone up and in, under the name given: their account's id, and the token that names it. Unless `payoutAccount` is false,
 * they also set the payout account the provider knows for them (request 16), so that they can be paid through the provider.
 */
async function signedIn(
  email: string,
  name = 'Alice',
  { payoutAccount = true }: { payoutAccount?: boolean } = {},
): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  const person = { id: operation.result as string, token: (login.body as { token: string }).token };
  if (payoutAccount)
    expect(await setPayoutAccount(person.token, payoutOf(person.id))).toMatchObject({ status: 'SUCCESS' });
  return person;
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
    expect(lastPayment()).toEqual({
      paymentId,
      reference: settlementId,
      amount: 30,
      currency: 'EUR',
      payee: payoutOf(ann.id),
    });

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

describe('payout accounts (request 16)', () => {
  it('sets the account a person is paid on to the one the provider knows, reads it back to that person only, and replaces it when set again', async () => {
    const ann = await signedIn('pa-ann@example.com', 'Ann', { payoutAccount: false });
    const bob = await signedIn('pa-bob@example.com', 'Bob', { payoutAccount: false });
    const read = (token?: string) => http.get(`${api}/accounts/me/payout-account`, { token });

    expect(await read(ann.token)).toMatchObject({ status: 404 });
    expect(await setPayoutAccount(ann.token, 'payout_first')).toMatchObject({ status: 'SUCCESS' });
    expect(await read(ann.token)).toMatchObject({ status: 200, body: { accountId: 'payout_first' } });

    expect(await setPayoutAccount(ann.token, 'payout_second')).toMatchObject({ status: 'SUCCESS' });
    expect(await read(ann.token)).toMatchObject({ status: 200, body: { accountId: 'payout_second' } });

    // Bob has set none: Ann's account is not his, and an anonymous caller is refused.
    expect(await read(bob.token)).toMatchObject({ status: 404 });
    expect(await read()).toMatchObject({ status: 401 });
  });

  it('refuses an account the provider does not know, when it answers anything else, when it is not configured, and keeps the account the person had', async () => {
    const ann = await signedIn('pa2-ann@example.com', 'Ann');
    const before = await http.get(`${api}/accounts/me/payout-account`, { token: ann.token });
    expect(before).toMatchObject({ body: { accountId: payoutOf(ann.id) } });

    unknownAccounts.add('payout_stranger');
    try {
      expect(await setPayoutAccount(ann.token, 'payout_stranger')).toMatchObject({
        status: 'ERROR',
        error: { type: 'UnknownPayoutAccount' },
      });
    } finally {
      unknownAccounts.delete('payout_stranger');
    }

    refusingAccounts = true;
    try {
      expect(await setPayoutAccount(ann.token, 'payout_flaky')).toMatchObject({
        status: 'ERROR',
        error: { type: 'UnknownPayoutAccount' },
      });
    } finally {
      refusingAccounts = false;
    }

    const url = process.env.PROVIDER_URL;
    delete process.env.PROVIDER_URL;
    try {
      expect(await setPayoutAccount(ann.token, 'payout_unconfigured')).toMatchObject({
        status: 'ERROR',
        error: { type: 'UnknownPayoutAccount' },
      });
    } finally {
      restoreEnv('PROVIDER_URL', url);
    }

    expect(await http.get(`${api}/accounts/me/payout-account`, { token: ann.token })).toMatchObject({
      body: { accountId: payoutOf(ann.id) },
    });
  });

  it('refuses a payment to a member with no payout account, by the name of its rule, and asks the provider nothing', async () => {
    const ann = await signedIn('pa3-ann@example.com', 'Ann');
    const bob = await signedIn('pa3-bob@example.com', 'Bob', { payoutAccount: false });
    const groupId = await createGroup(bob.token, 'Payouts');
    await join(bob.token, groupId, ann.token);
    expect(
      await record(bob.token, groupId, {
        description: 'Taxi',
        amount: 60,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const asked = issued.length;
    expect(await payThroughProvider(ann.token, groupId, { to: bob.id, amount: 30 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'PayeeHasNoPayoutAccount' },
    });
    expect(issued).toHaveLength(asked);
    expect(await suggested(ann.token, groupId)).toMatchObject({ body: [{ from: ann.id, to: bob.id, amount: 30 }] });

    // The same payee, once Bob has an account: the provider is asked, and the money goes to the account he set.
    expect(await setPayoutAccount(bob.token, payoutOf(bob.id))).toMatchObject({ status: 'SUCCESS' });
    expect(await payThroughProvider(ann.token, groupId, { to: bob.id, amount: 30 })).toMatchObject({
      status: 'SUCCESS',
    });
    expect(lastPayment()).toMatchObject({ amount: 30, payee: payoutOf(bob.id) });
  });

  it('records a settlement in cash to a member with no payout account, since a settlement in cash needs none', async () => {
    const ann = await signedIn('pa4-ann@example.com', 'Ann');
    const bob = await signedIn('pa4-bob@example.com', 'Bob', { payoutAccount: false });
    const groupId = await createGroup(bob.token, 'Cash');
    await join(bob.token, groupId, ann.token);
    expect(
      await record(bob.token, groupId, {
        description: 'Taxi',
        amount: 60,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 30 },
    });
    expect(await outcome((answer.body as { operationId: string }).operationId, bob.token)).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await balances(bob.token, groupId)).toMatchObject({ body: [{ balance: 0 }, { balance: 0 }] });
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

/** The provider's webhook, followed to its end: acknowledged at once with a 202, and the operation it made. */
async function deliver(body: object): Promise<Operation> {
  const answer = await webhook(body);
  expect(answer.status).toBe(202);
  return outcome((answer.body as { operationId: string }).operationId);
}

/** Starts a fresh application on the database file `DATABASE_PATH` names, as a server started after a stop does. */
async function startOnFile(): Promise<FastifyApplication> {
  jest.resetModules();
  const { createApplication: create } = await import('@Bootstrap/Fastify/createApplication');
  const started = await create();
  await started.start(0);
  http = apiClient(started.address);
  api = `/${started.apiPrefix}`;
  return started;
}

describe('webhooks late, twice or out of order (request 14)', () => {
  it('counts a payment once however many webhooks say it succeeded, and acknowledges each of them', async () => {
    const { ann, bob, groupId } = await dinnerGroup('wh1');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();
    const settlement = () => http.get(`${api}/settlements/${settlementId}`, { token: bob.token });

    // The same webhook twice, and a second webhook under another id that says the same thing.
    const succeeded = { id: 'wh_w1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' };
    expect(await deliver(succeeded)).toMatchObject({ status: 'SUCCESS' });
    expect(await deliver(succeeded)).toMatchObject({ status: 'SUCCESS' });
    expect(await deliver({ ...succeeded, id: 'wh_w2', at: '2026-11-17T10:00:05Z' })).toMatchObject({
      status: 'SUCCESS',
    });

    expect(await settlement()).toMatchObject({ body: { status: 'paid' } });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });

  it('keeps a payment that succeeded paid when a pending webhook arrives after it, and a failed one after a success changes nothing', async () => {
    const { ann, bob, groupId } = await dinnerGroup('wh2');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();
    const settlement = () => http.get(`${api}/settlements/${settlementId}`, { token: bob.token });

    expect(await deliver({ id: 'wh_o1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' })).toMatchObject({
      status: 'SUCCESS',
    });
    // The pending webhook was sent first and arrives last.
    expect(await deliver({ id: 'wh_o2', paymentId, status: 'pending', at: '2026-11-17T09:59:00Z' })).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await deliver({ id: 'wh_o3', paymentId, status: 'failed', at: '2026-11-17T10:01:00Z' })).toMatchObject({
      status: 'SUCCESS',
    });

    expect(await settlement()).toMatchObject({ body: { status: 'paid' } });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });

  it('counts a webhook that reaches Tally more than once at the same moment once', async () => {
    const { ann, bob, groupId } = await dinnerGroup('wh3');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();

    const body = { id: 'wh_c1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' };
    const answers = await Promise.all([webhook(body), webhook(body), webhook(body)]);
    expect(answers.map(answer => answer.status)).toEqual([202, 202, 202]);
    for (const answer of answers) {
      expect(await outcome((answer.body as { operationId: string }).operationId)).toMatchObject({ status: 'SUCCESS' });
    }

    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      body: { status: 'paid' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });

  it('applies a webhook that arrives after Tally was stopped and started again on the same file, and acknowledges one that changes nothing', async () => {
    const directory = mkdtempSync(`${tmpdir()}/tally-webhooks-`);
    const previousDatabase = process.env.DATABASE_PATH;
    const previousHttp = { http, api };
    process.env.DATABASE_PATH = `${directory}/tally.sqlite`;
    let running: FastifyApplication | undefined;
    try {
      running = await startOnFile();
      const { ann, bob, groupId } = await dinnerGroup('wh4');
      const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
      const { paymentId } = lastPayment();

      // Tally stops before the provider's webhook arrives, and is started again on the same file.
      await running.stop();
      running = await startOnFile();

      // The accounts are the same; each signs in again, as after a restart.
      const login = async (email: string) =>
        (await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } })).body as {
          token: string;
        };
      const bobToken = (await login('wh4-bob@example.com')).token;
      const annToken = (await login('wh4-ann@example.com')).token;

      expect(await deliver({ id: 'wh_s1', paymentId, status: 'succeeded', at: '2026-11-19T08:00:00Z' })).toMatchObject({
        status: 'SUCCESS',
      });
      // A webhook about the same payment, days after it was decided, changes nothing.
      expect(await deliver({ id: 'wh_s2', paymentId, status: 'failed', at: '2026-11-22T08:00:00Z' })).toMatchObject({
        status: 'SUCCESS',
      });

      expect(await http.get(`${api}/settlements/${settlementId}`, { token: bobToken })).toMatchObject({
        body: { status: 'paid' },
      });
      expect(await balances(annToken, groupId)).toMatchObject({
        body: [
          { memberId: ann.id, balance: 0 },
          { memberId: bob.id, balance: 0 },
        ],
      });
    } finally {
      if (running) await running.stop();
      http = previousHttp.http;
      api = previousHttp.api;
      if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabase;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Asks to refund a settlement, as its payee, and follows the operation of the request; an answer that is not 202 is its status. */
async function refund(token: string, settlementId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

describe('refund through the provider (request 15)', () => {
  it('asks the provider to refund a paid settlement, keeps it refunding and still counted until the provider says it was refunded', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rf1');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();
    expect(await deliver({ id: 'wh_rf1_1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' })).toMatchObject(
      {
        status: 'SUCCESS',
      },
    );
    const settlement = () => http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
    expect(await settlement()).toMatchObject({ body: { status: 'paid' } });

    // Only the payee may refund, and only a settlement paid through the provider that is still paid.
    expect(await refund(bob.token, settlementId)).toMatchObject({
      status: 'ERROR',
      error: { type: 'OnlyThePayeeMayRefund' },
    });
    expect(await refund(bob.token, 'no-such-settlement')).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotFound' },
    });
    expect(refunded).toHaveLength(0);

    // The provider accepts the refund: the settlement is refunding, the balances still count it, and the provider was asked
    // for the payment, with the settlement's id as its reference.
    expect(await refund(ann.token, settlementId)).toMatchObject({ status: 'SUCCESS' });
    expect(refunded).toEqual([{ paymentId, reference: settlementId }]);
    expect(await settlement()).toMatchObject({ body: { status: 'refunding' } });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
    expect(await refund(ann.token, settlementId)).toMatchObject({
      status: 'ERROR',
      error: { type: 'OnlyAPaidSettlementIsRefunded' },
    });

    // The provider says it was refunded: the settlement is refunded, and the balances go back to what they were before it was paid.
    expect(await deliver({ id: 'wh_rf1_2', paymentId, status: 'refunded', at: '2026-11-17T11:00:00Z' })).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await settlement()).toMatchObject({ body: { status: 'refunded' } });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });

    // A refunded said twice counts once, and a succeeded that arrives after it changes nothing.
    expect(await deliver({ id: 'wh_rf1_3', paymentId, status: 'refunded', at: '2026-11-17T11:00:05Z' })).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await deliver({ id: 'wh_rf1_4', paymentId, status: 'succeeded', at: '2026-11-17T11:00:09Z' })).toMatchObject(
      {
        status: 'SUCCESS',
      },
    );
    expect(await settlement()).toMatchObject({ body: { status: 'refunded' } });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });
  });

  it('refuses a refund the provider does not accept, and changes nothing', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rf2');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();
    await deliver({ id: 'wh_rf2_1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' });

    refusingRefunds = true;
    try {
      expect(await refund(ann.token, settlementId)).toMatchObject({
        status: 'ERROR',
        error: { type: 'ProviderRefundUnavailable' },
      });
    } finally {
      refusingRefunds = false;
    }
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).toMatchObject({
      body: { status: 'paid' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });

  it('refuses to refund a settlement in cash, a settlement not yet paid, and one whose payer has left the group', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rf3');
    const asked = refunded.length;
    // Bob owes 30: 10 in cash to Ann, then 20 through the provider, so that his balance is 0 and he may leave.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 10 },
    });
    expect(cash.status).toBe(202);
    const cashId = (await outcome((cash.body as { operationId: string }).operationId, ann.token)).result as string;
    expect(await refund(ann.token, cashId)).toMatchObject({ status: 'ERROR', error: { type: 'CashIsNotRefunded' } });

    const paid = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 20 })).result as string;
    expect(await refund(ann.token, paid)).toMatchObject({
      status: 'ERROR',
      error: { type: 'OnlyAPaidSettlementIsRefunded' },
    });
    const { paymentId } = lastPayment();
    expect(await deliver({ id: 'wh_rf3_1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' })).toMatchObject(
      {
        status: 'SUCCESS',
      },
    );

    // Bob leaves once his balance is 0: his payment through the provider is no longer refunded.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBe(202);
    expect(await outcome((left.body as { operationId: string }).operationId, bob.token)).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await refund(ann.token, paid)).toMatchObject({ status: 'ERROR', error: { type: 'PayerNotAMember' } });
    expect(refunded).toHaveLength(asked);
  });

  it('a refunded that overtakes the success of the same payment leaves the settlement refunded, never counted; a refund without a signed-in caller is refused at once', async () => {
    const { ann, bob, groupId } = await dinnerGroup('rf4');
    const settlementId = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 })).result as string;
    const { paymentId } = lastPayment();

    expect(await deliver({ id: 'wh_rf4_1', paymentId, status: 'refunded', at: '2026-11-17T10:00:00Z' })).toMatchObject({
      status: 'SUCCESS',
    });
    expect(await deliver({ id: 'wh_rf4_2', paymentId, status: 'succeeded', at: '2026-11-17T10:00:02Z' })).toMatchObject(
      {
        status: 'SUCCESS',
      },
    );
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).toMatchObject({
      body: { status: 'refunded' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });

    // Without a signed-in caller, a refund is refused at the transport, and nothing is asked of the provider.
    expect(await http.request('POST', `${api}/settlements/${settlementId}/refund`, {})).toMatchObject({ status: 401 });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('keeps the id a payment request answered, has Groups refuse the leave of the member it waits on, and lets the leave through once the webhook says that same settlement was paid', async () => {
    const { ann, bob, groupId } = await dinnerGroup('lv1');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 10 });
    expect(paid).toMatchObject({ status: 'SUCCESS' });
    const settlementId = paid.result as string;
    const { paymentId } = lastPayment();
    expect((await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).body).toMatchObject({
      id: settlementId,
      status: 'pending',
    });

    const waiting = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(await outcome((waiting.body as { operationId: string }).operationId, bob.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'PaymentWaitingAtProvider' },
    });
    expect((await http.get(`${api}/groups/${groupId}`, { token: bob.token })).status).toBe(200);

    expect(await deliver({ id: 'wh_lv1_1', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' })).toMatchObject(
      {
        status: 'SUCCESS',
      },
    );
    expect((await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).body).toMatchObject({
      id: settlementId,
      status: 'paid',
    });
    // Bob owed 30 and paid 10 of it: he owes 20, which passes to Ann; the balances of the group are Ann's, at 0.
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 20 },
        { memberId: bob.id, balance: -20 },
      ],
    });
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(await outcome((left.body as { operationId: string }).operationId, bob.token)).toMatchObject({
      status: 'SUCCESS',
    });
    expect((await balances(ann.token, groupId)).body).toEqual([{ memberId: ann.id, balance: 0 }]);
  });
});
