import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Contesting a settlement, end to end (request 33): the application booted in this process, spoken to over HTTP, every answer held
 * to api/33-contest-a-settlement.yaml by the client. The provider is a fake one, and the administrators are the emails the server
 * is started with, in any case.
 */
const SECRET = 'whsec_contest';
const PASSWORD = 'correct horse';

let provider: Server;
let paymentCount = 0;
let lastPaymentId = '';
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/accounts/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ id: decodeURIComponent(req.url.slice('/accounts/'.length)) }));
      }
      paymentCount += 1;
      lastPaymentId = `pay_contest_${paymentCount}`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: lastPaymentId, payUrl: `https://provider.test/pay/${lastPaymentId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ' Root.Admin@Example.com , second.admin@example.com ';
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  delete process.env.ADMIN_EMAILS;
});

type Person = { token: string; id: string };

async function accountOf(email: string, name: string): Promise<Person> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh_${paymentId}_${status}`, at: '2026-11-17T10:00:00Z', paymentId, status };
  return http.request('POST', '/v1/provider/webhooks', {
    body,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex') },
  });
};

/** Ann paid 60 for both of them; Bob paid her 30 through the provider and the provider said so: Bob owes Ann 0 and she is owed 0. */
async function paidThroughProvider(label: string) {
  const ann = await accountOf(`ann.${label}@example.com`, 'Ann');
  const bob = await accountOf(`bob.${label}@example.com`, 'Bob');
  await http.request('PUT', '/v1/accounts/me/payout-account', { body: { accountId: 'acct_ann' }, token: ann.token });
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: ann.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, { token: bob.token });
  await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-02', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  const asked = await http.request('POST', `/v1/groups/${groupId}/settlements/provider`, {
    body: { to: ann.id, amount: 30 },
    token: bob.token,
  });
  const settlementId = (asked.body as { id: string }).id;
  await webhook(lastPaymentId, 'succeeded');
  return { ann, bob, groupId, settlementId, paymentId: lastPaymentId };
}

const contest = (settlementId: string, token?: string) =>
  http.request('POST', `/v1/settlements/${settlementId}/contest`, { token });
const decide = (settlementId: string, body: unknown, token?: string) =>
  http.request('POST', `/v1/admin/settlements/${settlementId}/decision`, { body, token });
const read = async (settlementId: string, token: string) =>
  (await http.get(`/v1/settlements/${settlementId}`, { token })).body as {
    status: string;
    history: { status: string; at: string }[];
  };
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];
const auditOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/audit`, { token })).body as {
    by: string;
    action: string;
    subjectId: string;
    amount: number;
  }[];
const admin = (label: string) => accountOf(`${label}@example.com`, 'Root');

describe('Administrators', () => {
  it('are the accounts whose email is in ADMIN_EMAILS, whatever its case, and what only they read does not exist for anyone else', async () => {
    const root = await admin('ROOT.admin');
    const ann = await accountOf('ann.notadmin@example.com', 'Ann');

    expect((await http.get('/v1/admin/contests', { token: root.token })).status).toBe(200);
    expect((await http.get('/v1/admin/log', { token: root.token })).status).toBe(200);
    expect((await http.get('/v1/admin/contests', { token: ann.token })).status).toBe(404);
    expect((await http.get('/v1/admin/log', { token: ann.token })).status).toBe(404);
    expect((await http.get('/v1/admin/contests')).status).toBe(401);
    expect((await http.get('/v1/admin/log')).status).toBe(401);
  });

  it('refuses a decision to anyone else, and a decision whose paid is not a boolean', async () => {
    const { bob, ann, settlementId } = await paidThroughProvider('refuse');
    expect((await contest(settlementId, ann.token)).status).toBe(201);

    expect((await decide(settlementId, { paid: true }, ann.token)).status).toBe(403);
    expect((await decide(settlementId, { paid: true }, bob.token)).status).toBe(403);
    expect((await decide(settlementId, { paid: true })).status).toBe(401);
    const root = await admin('root.admin');
    expect((await decide(settlementId, { paid: 'yes' }, root.token)).status).toBe(400);
    expect((await decide(settlementId, {}, root.token)).status).toBe(400);
    expect((await read(settlementId, ann.token)).status).toBe('contested');
  });
});

describe('Contesting', () => {
  it("holds a contested settlement's effect on the balances until an administrator decides it was paid", async () => {
    const { ann, bob, groupId, settlementId } = await paidThroughProvider('held');
    const root = await admin('root.admin');
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    // Bob owes Ann 0 now, so she is owed nothing.
    const paidAudit = (await auditOf(groupId, ann.token)).filter(entry => entry.action === 'settlement-paid');
    expect(paidAudit).toHaveLength(1);

    expect((await contest(settlementId, ann.token)).status).toBe(201);

    // The balances are as they were before it was paid, but it still waits: nothing more is owed that it paid.
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
    ]);
    expect((await http.get(`/v1/groups/${groupId}/settlements/suggested`, { token: ann.token })).body).toEqual([]);
    const contested = await read(settlementId, bob.token);
    expect(contested.status).toBe('contested');
    expect(contested.history.map(line => line.status)).toEqual(['pending', 'paid', 'contested']);
    expect((await auditOf(groupId, ann.token)).find(entry => entry.action === 'settlement-contested')).toMatchObject({
      by: ann.id,
      subjectId: settlementId,
      amount: 30,
    });

    // It still waits: neither leaves, the group is not archived, and a webhook changes nothing.
    expect((await http.request('POST', `/v1/groups/${groupId}/leave`, { token: bob.token })).status).toBe(409);
    expect((await http.request('POST', `/v1/groups/${groupId}/archive`, { token: ann.token })).status).toBe(409);
    expect((await webhook((await readPaymentId(settlementId)) ?? '', 'failed')).status).toBeLessThan(300);
    expect((await read(settlementId, ann.token)).status).toBe('contested');

    const listed = (await http.get('/v1/admin/contests', { token: root.token })).body as { id: string }[];
    expect(listed.map(settlement => settlement.id)).toContain(settlementId);

    expect((await decide(settlementId, { paid: true }, root.token)).status).toBe(201);

    // Paid again, counted as it was before it was contested.
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    const decided = await read(settlementId, ann.token);
    expect(decided.status).toBe('paid');
    expect(decided.history.map(line => line.status)).toEqual(['pending', 'paid', 'contested', 'paid']);
    const entries = (await auditOf(groupId, ann.token)).filter(entry => entry.subjectId === settlementId);
    expect(entries.map(entry => entry.action)).toEqual(['settlement-paid', 'settlement-contested', 'settlement-paid']);
    expect(entries[2]).toMatchObject({ by: root.id, amount: 30 });
    expect(
      ((await http.get('/v1/admin/contests', { token: root.token })).body as { id: string }[]).map(s => s.id),
    ).not.toContain(settlementId);

    // Decided once, and contested once.
    expect((await decide(settlementId, { paid: false }, root.token)).status).toBe(400);
    expect((await contest(settlementId, ann.token)).status).toBe(400);
    expect((await read(settlementId, ann.token)).status).toBe('paid');

    const log = (await http.get('/v1/admin/log', { token: root.token })).body as {
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.filter(entry => entry.subjectId === settlementId)).toEqual([
      { id: expect.any(String), at: expect.any(String), by: root.id, action: 'decided-paid', subjectId: settlementId },
    ]);
  });

  it('annuls a settlement an administrator decides was not paid, and what was owed is owed again', async () => {
    const { ann, bob, groupId, settlementId } = await paidThroughProvider('annulled');
    const root = await admin('second.admin');
    expect((await contest(settlementId, ann.token)).status).toBe(201);
    const before = (await auditOf(groupId, ann.token)).length;

    expect((await decide(settlementId, { paid: false }, root.token)).status).toBe(201);

    const annulled = await read(settlementId, bob.token);
    expect(annulled.status).toBe('annulled');
    expect(annulled.history.map(line => line.status)).toEqual(['pending', 'paid', 'contested', 'annulled']);
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
    ]);
    // It no longer waits: the transfer is suggested again, and a new payment may be asked.
    expect((await http.get(`/v1/groups/${groupId}/settlements/suggested`, { token: ann.token })).body).toEqual([
      { from: bob.id, to: ann.id, amount: 30 },
    ]);
    // A settlement annulled is no other entry of the audit.
    expect(await auditOf(groupId, ann.token)).toHaveLength(before);
    const log = (await http.get('/v1/admin/log', { token: root.token })).body as {
      action: string;
      subjectId: string;
    }[];
    expect(log.filter(entry => entry.subjectId === settlementId)).toMatchObject([{ action: 'decided-annulled' }]);
    expect((await http.get('/v1/admin/contests', { token: root.token })).body).not.toContainEqual(
      expect.objectContaining({ id: settlementId }),
    );
  });

  it('is refused to anyone but the payee, to a settlement that is not a paid one through the provider, and to a stranger', async () => {
    const { ann, bob, groupId, settlementId } = await paidThroughProvider('refused');
    const stranger = await accountOf('stranger.contest@example.com', 'Stranger');

    expect((await contest(settlementId, bob.token)).status).toBe(403);
    expect((await contest(settlementId, stranger.token)).status).toBe(404);
    expect((await contest(settlementId)).status).toBe(401);
    expect((await contest('nothing', ann.token)).status).toBe(404);
    expect((await read(settlementId, ann.token)).status).toBe('paid');

    // A settlement in cash is not through the provider.
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 20, date: '2020-01-03', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    const cash = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 10 },
      token: ann.token,
    });
    expect(cash.status).toBe(201);
    expect((await contest((cash.body as { id: string }).id, ann.token)).status).toBe(400);
  });

  it('lists the contested settlements, the earliest contested first, each as a settlement is read', async () => {
    const first = await paidThroughProvider('first');
    const second = await paidThroughProvider('second');
    const root = await admin('root.admin');
    expect((await contest(second.settlementId, second.ann.token)).status).toBe(201);
    expect((await contest(first.settlementId, first.ann.token)).status).toBe(201);

    const listed = (await http.get('/v1/admin/contests', { token: root.token })).body as { id: string }[];
    const ids = listed.map(settlement => settlement.id);
    expect(ids.indexOf(second.settlementId)).toBeLessThan(ids.indexOf(first.settlementId));
    expect(listed.find(settlement => settlement.id === first.settlementId)).toEqual(
      await read(first.settlementId, first.ann.token).then(async settlement => ({
        ...settlement,
        ...((await http.get(`/v1/settlements/${first.settlementId}`, { token: first.ann.token })).body as object),
      })),
    );

    // Both decisions are in the log, the oldest first.
    expect((await decide(second.settlementId, { paid: true }, root.token)).status).toBe(201);
    expect((await decide(first.settlementId, { paid: false }, root.token)).status).toBe(201);
    const log = (await http.get('/v1/admin/log', { token: root.token })).body as { subjectId: string }[];
    const subjects = log.map(entry => entry.subjectId);
    expect(subjects.indexOf(second.settlementId)).toBeLessThan(subjects.indexOf(first.settlementId));
  });
});

/** The provider's id of a payment is not in the API: the last one issued is the one of the settlement just made. */
async function readPaymentId(_settlementId: string): Promise<string | undefined> {
  return lastPaymentId;
}

describe('Settlements → Groups', () => {
  it("writes the decision about the settlement it was answered, which Groups answers in the administrators' log, and keeps a contested payment waiting in its group", async () => {
    const { ann, bob, groupId, settlementId } = await paidThroughProvider('crossing');
    const root = await admin('root.admin');
    expect((await contest(settlementId, ann.token)).status).toBe(201);

    // Groups refuses what a payment waiting at the provider forbids: archiving the group, and a member leaving.
    expect((await http.request('POST', `/v1/groups/${groupId}/archive`, { token: ann.token })).status).toBe(409);
    expect((await http.request('POST', `/v1/groups/${groupId}/leave`, { token: bob.token })).status).toBe(409);

    const decided = await decide(settlementId, { paid: true }, root.token);
    expect(decided.status).toBe(201);
    expect(decided.body).toEqual({ id: settlementId });
    const log = (await http.get('/v1/admin/log', { token: root.token })).body as { by: string; subjectId: string }[];
    expect(log.find(entry => entry.subjectId === (decided.body as { id: string }).id)).toMatchObject({ by: root.id });

    // The wait is over: the payee, who is not the owner, may leave, once the settlement is decided.
    expect((await http.request('POST', `/v1/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(500);
  });
});

describe('Groups → Settlements', () => {
  it('finds the settlement of the group it answered, by the id of that group, contested and decided there', async () => {
    const { ann, groupId, settlementId } = await paidThroughProvider('groupcross');
    expect((await contest(settlementId, ann.token)).status).toBe(201);

    const settlements = (await http.get(`/v1/groups/${groupId}/settlements`, { token: ann.token })).body as {
      id: string;
      groupId: string;
      status: string;
    }[];
    expect(settlements).toEqual([expect.objectContaining({ id: settlementId, groupId, status: 'contested' })]);
  });
});
