import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider';

/** A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment, and records what it was asked. */
let provider: Server;
let asked: { reference: string; amount: number; currency: string }[] = [];
let refusing = false;
let counter = 0;

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
        // The provider knows the accounts that start with `acct-` (request 16).
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
      asked.push(JSON.parse(data));
      if (refusing) {
        res.writeHead(500).end();
        return;
      }
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `prov-${counter}`, payUrl: `https://pay.example/prov-${counter}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'pay-provider-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
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
  const email = `pay-provider-${name.toLowerCase()}-${++accountCount}@example.com`;
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

/** Records an expense the caller paid, split between the members named, and answers the expense's id. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result?: { id: string } }).result?.id as string;
}

/** Asks to pay another member through the provider, and follows it to its outcome. */
async function payThroughProvider(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

/** Sends the provider's webhook: signed as the provider signs it, with the given signature, or unsigned (`false`). */
async function webhook(payload: Body, signed: string | false = sign(payload)) {
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: signed === false ? {} : { 'provider-signature': signed },
  });
}

function sign(payload: Body): string {
  return createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
}

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30. */
/** The person sets the payout account the provider knows, and follows it to its outcome (request 16). */
async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  return outcome((answer.body as Body).operationId as string, token);
}

async function owing(name: string) {
  const ann = await person(`${name}Ann`);
  await setPayoutAccount(ann.token, `acct-${ann.id}`);
  const bob = await person(`${name}Bob`);
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 60,
    date: serverToday,
    splitBetween: [ann.id, bob.id],
  });
  return { ann, bob, groupId };
}

describe('Settlements: a payment through the provider waits as pending, and the provider says how it ended', () => {
  it('asks the provider for a link, keeps the settlement pending and not counted, and counts it once the provider says it succeeded', async () => {
    const { ann, bob, groupId } = await owing('Ok');
    asked = [];

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    expect(paid.status).toBe('SUCCESS');
    const id = (paid.body.result as { id: string }).id;
    expect(asked).toEqual([{ reference: id, amount: 30, currency: 'EUR', payee: `acct-${ann.id}` }]);

    const read = await http.get(`${api}/settlements/${id}`, { token: bob.token });
    expect(read.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 30,
      method: 'provider',
      status: 'pending',
      at: expect.any(String),
      history: [{ status: 'pending', at: expect.any(String) }],
      payUrl: 'https://pay.example/prov-' + String(counter),
      // A settlement through the provider asked from request 38 on reads the fee it was asked with (request 38): none here.
      fee: { amount: 0, borneBy: 'payee' },
    });
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    const waiting = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(waiting.body).toEqual([]);

    const told = await webhook({
      id: 'wh-1',
      paymentId: `prov-${counter}`,
      status: 'succeeded',
      at: '2026-11-17T10:00:00Z',
    });
    expect(told.status).toBe(202);
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    const paidRead = await http.get(`${api}/settlements/${id}`, { token: bob.token });
    expect((paidRead.body as Body).status).toBe('paid');
  });

  it('marks a settlement the provider says failed, never counts it, and frees what it held', async () => {
    const { ann, bob, groupId } = await owing('Failed');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;

    await webhook({ id: 'wh-2', paymentId: `prov-${counter}`, status: 'failed', at: '2026-11-17T10:00:00Z' });

    const read = await http.get(`${api}/settlements/${id}`, { token: bob.token });
    expect((read.body as Body).status).toBe('failed');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    const again = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    expect(again.status).toBe('SUCCESS');
  });

  it('refuses a payment that is more than is still owed, when one is waiting, and changes nothing', async () => {
    const { ann, bob, groupId } = await owing('Waiting');
    expect((await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 20 })).status).toBe('SUCCESS');

    const over = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 15 });
    expect(over.status).toBe('ERROR');
    expect(over.body.error).toMatchObject({ type: 'SettlementExceedsDebt' });
  });

  it('refuses a payment the provider does not give a link for, and keeps nothing', async () => {
    const { ann, bob, groupId } = await owing('Refused');
    refusing = true;
    try {
      const refused = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
      expect(refused.status).toBe('ERROR');
      expect(refused.body.error).toMatchObject({ type: 'ProviderUnavailable' });
    } finally {
      refusing = false;
    }
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(suggested.body).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  });

  it('refuses an unsigned webhook or one with a wrong signature with 401, and changes nothing', async () => {
    const { ann, bob, groupId } = await owing('Unsigned');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    const payload = { id: 'wh-3', paymentId: `prov-${counter}`, status: 'succeeded', at: '2026-11-17T10:00:00Z' };

    expect((await webhook(payload, false)).status).toBe(401);
    expect((await webhook(payload, 'f'.repeat(64))).status).toBe(401);

    const read = await http.get(`${api}/settlements/${id}`, { token: bob.token });
    expect((read.body as Body).status).toBe('pending');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });

  it('acknowledges a signed webhook about a payment Tally does not know, and changes nothing', async () => {
    const { ann, bob, groupId } = await owing('Unknown');
    const told = await webhook({ id: 'wh-4', paymentId: 'nobody', status: 'succeeded', at: '2026-11-17T10:00:00Z' });

    expect(told.status).toBe(202);
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });
});

describe('Groups → Settlements (GroupCurrency): the group Groups makes is the one the provider is asked about, in its currency, by the id its request answered', () => {
  it('asks the provider in the currency the group was made in, and reads the settlement for the group that answered it', async () => {
    const { ann, bob, groupId } = await owing('Currency');
    asked = [];

    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 10 });
    const settlementId = (paid.body.result as { id: string }).id;

    expect(asked).toEqual([{ reference: settlementId, amount: 10, currency: 'EUR', payee: `acct-${ann.id}` }]);
    const read = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect((read.body as Body).groupId).toBe(groupId);
    expect((read.body as Body).id).toBe(settlementId);
  });
});

describe('Ledger → Settlements (GroupBalances): the expense Ledger records is the balance the provider payment is asked against, by the id its request answered', () => {
  it('reads the expense by the id its request answered, and asks for no more than the expense leaves owed', async () => {
    const ann = await person('LedgerAnn');
    await setPayoutAccount(ann.token, `acct-${ann.id}`);
    const bob = await person('LedgerBob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    const expenseId = await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const expense = await http.get(`${api}/expenses/${expenseId}`, { token: bob.token });
    expect((expense.body as Body).id).toBe(expenseId);
    const over = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 31 });
    expect(over.body.error).toMatchObject({ type: 'SettlementExceedsDebt' });
    const exact = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    expect(exact.status).toBe('SUCCESS');
  });
});
