import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider-for-contests';
const ADMIN_EMAIL = 'Contest-Admin@Example.com';

/** A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment, and knows the accounts `acct-…` (request 16). */
let provider: Server;
let counter = 0;
let lastProviderId = '';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;
let admin: { token: string; id: string };

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
      counter++;
      lastProviderId = `prov-${counter}`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: lastProviderId, payUrl: `https://pay.example/${lastProviderId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = `someone-else@example.com, ${ADMIN_EMAIL.toLowerCase()}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'contest-probe@example.com', password: 'correct horse', name: 'Probe' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
  admin = await person('Admin', ADMIN_EMAIL);
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

/** Signs up and in a new account, and answers its token and its id. An administrator's email is one of ADMIN_EMAILS. */
async function person(name: string, email?: string) {
  const address = email ?? `contest-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email: address, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email: address, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  return outcome((answer.body as Body).operationId as string, token);
}

/** The payer pays the payee through the provider, and the provider says it succeeded: the settlement is paid. */
async function paidThroughProvider(payer: { token: string }, groupId: string, payee: { id: string }, amount: number) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: payee.id, amount },
    token: payer.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, payer.token);
  const settlementId = (done.body.result as { id: string }).id;
  const paymentId = lastProviderId;
  const payload = { id: `wh-${paymentId}`, paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' };
  await webhook(payload);
  return settlementId;
}

async function webhook(payload: Body) {
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex') },
  });
}

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

async function settlement(id: string, token: string) {
  const read = await http.get(`${api}/settlements/${id}`, { token });
  return read.body as Body;
}

/**
 * Ann (the payee) and Bob (the payer) in a group, with Ann having paid 60 for dinner split with Bob: Bob owes Ann 30. Bob pays
 * it through the provider, and the provider says it succeeded. The settlement is paid.
 */
async function paidSettlement(tag: string) {
  const ann = await person(`${tag}Ann`);
  await setPayoutAccount(ann.token, `acct-${ann.id}`);
  const bob = await person(`${tag}Bob`);
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 60,
    date: serverToday,
    splitBetween: [ann.id, bob.id],
  });
  const id = await paidThroughProvider(bob, groupId, ann, 30);
  return { ann, bob, groupId, id };
}

describe('Settlements: a settlement paid through the provider is contested by its payee, held until an administrator decides it', () => {
  it('holds a contested settlement out of the balances, and an administrator decides it was paid', async () => {
    const { ann, bob, groupId, id } = await paidSettlement('Paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });

    const asked = await http.request('POST', `${api}/settlements/${id}/contest`, { token: ann.token });
    expect(asked.status).toBe(202);
    expect((await outcome((asked.body as Body).operationId as string, ann.token)).body.status).toBe('SUCCESS');
    expect((await settlement(id, ann.token)).status).toBe('contested');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });

    const contests = await http.get(`${api}/admin/contests`, { token: admin.token });
    expect(contests.status).toBe(200);
    expect((contests.body as { id: string }[]).map(s => s.id)).toContain(id);

    const decided = await http.request('POST', `${api}/admin/settlements/${id}/decision`, {
      body: { paid: true },
      token: admin.token,
    });
    expect(decided.status).toBe(202);
    expect((await outcome((decided.body as Body).operationId as string, admin.token)).body.status).toBe('SUCCESS');

    const read = await settlement(id, ann.token);
    expect(read.status).toBe('paid');
    expect((read.history as { status: string }[]).map(line => line.status)).toEqual([
      'pending',
      'paid',
      'contested',
      'paid',
    ]);
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });

    const audit = await http.get(`${api}/groups/${groupId}/audit`, { token: ann.token });
    const changes = (audit.body as { action: string; by: string; amount: number }[]).filter(entry =>
      entry.action.startsWith('settlement-'),
    );
    const actions = changes.map(entry => [entry.action, entry.by, entry.amount]);
    expect(actions).toEqual([
      ['settlement-paid', bob.id, 30],
      ['settlement-contested', ann.id, 30],
      ['settlement-paid', admin.id, 30],
    ]);

    const log = await http.get(`${api}/admin/log`, { token: admin.token });
    const entries = log.body as { by: string; action: string; subjectId: string }[];
    expect(entries.map(entry => [entry.by, entry.action, entry.subjectId])).toContainEqual([
      admin.id,
      'decided-paid',
      id,
    ]);
  });

  it('annuls a contested settlement an administrator decides was not paid, and what was owed is owed again', async () => {
    const { ann, bob, groupId, id } = await paidSettlement('Annul');
    const asked = await http.request('POST', `${api}/settlements/${id}/contest`, { token: ann.token });
    await outcome((asked.body as Body).operationId as string, ann.token);

    const decided = await http.request('POST', `${api}/admin/settlements/${id}/decision`, {
      body: { paid: false },
      token: admin.token,
    });
    expect((await outcome((decided.body as Body).operationId as string, admin.token)).body.status).toBe('SUCCESS');

    expect((await settlement(id, ann.token)).status).toBe('annulled');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
    const audit = await http.get(`${api}/groups/${groupId}/audit`, { token: ann.token });
    const changes = (audit.body as { action: string }[])
      .map(entry => entry.action)
      .filter(action => action.startsWith('settlement-'));
    expect(changes).toEqual(['settlement-paid', 'settlement-contested']);
  });

  it('refuses a contest by anyone but the payee, a second one, and a decision or a list by anyone but an administrator', async () => {
    const { ann, bob, id } = await paidSettlement('Refuse');
    const byPayer = await http.request('POST', `${api}/settlements/${id}/contest`, { token: bob.token });
    const refusedPayer = await outcome((byPayer.body as Body).operationId as string, bob.token);
    expect(refusedPayer.body.status).toBe('ERROR');
    expect((refusedPayer.body.error as { type: string }).type).toBe('NotThePayee');

    const first = await http.request('POST', `${api}/settlements/${id}/contest`, { token: ann.token });
    await outcome((first.body as Body).operationId as string, ann.token);
    const again = await http.request('POST', `${api}/settlements/${id}/contest`, { token: ann.token });
    const refusedAgain = await outcome((again.body as Body).operationId as string, ann.token);
    expect((refusedAgain.body.error as { type: string }).type).toBe('SettlementAlreadyContested');

    expect((await http.get(`${api}/admin/contests`, { token: ann.token })).status).toBe(403);
    expect((await http.get(`${api}/admin/contests`)).status).toBe(401);
    expect((await http.get(`${api}/admin/log`, { token: ann.token })).status).toBe(403);

    const asPayee = await http.request('POST', `${api}/admin/settlements/${id}/decision`, {
      body: { paid: true },
      token: ann.token,
    });
    const refusedDecision = await outcome((asPayee.body as Body).operationId as string, ann.token);
    expect(refusedDecision.body.status).toBe('ERROR');
    expect((await settlement(id, ann.token)).status).toBe('contested');
  });
});
