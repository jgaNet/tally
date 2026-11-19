import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider-for-contest-relationships';
const ADMIN_EMAIL = 'contest-relationship-admin@example.com';

/** A stand-in for the payment provider: it answers a payment with an id and a link, and knows the accounts `acct-…`. */
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
      lastProviderId = `prov-rel-${counter}`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: lastProviderId, payUrl: `https://pay.example/${lastProviderId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'contest-relationship-probe@example.com', password: 'correct horse', name: 'Probe' },
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

async function person(name: string, email?: string) {
  const address = email ?? `contest-rel-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email: address, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email: address, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
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

async function webhook(payload: Body) {
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex') },
  });
}

describe('Groups → Settlements (GroupCurrency, SettlementMembers): a group Groups makes is the one Settlements reads, by the id it answered', () => {
  it('finds the group Groups answered, with its members, by that id, and not at all for someone outside it', async () => {
    const owner = await person('GroupOwner');
    const member = await person('GroupMember');
    const outsider = await person('GroupOutsider');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Rel', currency: 'EUR' },
      token: owner.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, owner.token)).body.result as { id: string }
    ).id;
    await join(groupId, owner, member);
    await record(owner.token, groupId, {
      description: 'Lunch',
      amount: 40,
      date: serverToday,
      splitBetween: [owner.id, member.id],
    });

    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: member.token });
    expect(suggested.status).toBe(200);
    expect(suggested.body).toEqual([{ from: member.id, to: owner.id, amount: 20 }]);
    const listed = await http.get(`${api}/groups/${groupId}/settlements`, { token: member.token });
    expect(listed.status).toBe(200);
    expect((await http.get(`${api}/groups/${groupId}/settlements`, { token: outsider.token })).status).toBe(404);
  });
});

describe('Settlements → Groups (AdministratorDecisions, WaitingPayments): a settlement Settlements makes is the one Groups reads, by the id it answered', () => {
  it("reads the administrators' decision on the settlement a payment made, by the settlement id, and holds the group while it is contested", async () => {
    const ann = await person('RelAnn');
    await setPayoutAccount(ann.token, `acct-${ann.id}`);
    const bob = await person('RelBob');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Held', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, ann.token)).body.result as { id: string }
    ).id;
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    // Settlements makes the settlement: the id is the one its operation answered.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 30 },
      token: bob.token,
    });
    const settlementId = (
      (await outcome((paid.body as Body).operationId as string, bob.token)).body.result as { id: string }
    ).id;
    await webhook({
      id: `wh-${lastProviderId}`,
      paymentId: lastProviderId,
      status: 'succeeded',
      at: '2026-11-17T10:00:00Z',
    });

    const contest = await http.request('POST', `${api}/settlements/${settlementId}/contest`, { token: ann.token });
    expect((await outcome((contest.body as Body).operationId as string, ann.token)).body.status).toBe('SUCCESS');

    // Groups holds the group while the settlement is contested: a payee leaving is refused by WaitingPayments.
    const leave = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect((await outcome((leave.body as Body).operationId as string, bob.token)).body.status).toBe('ERROR');

    // Settlements decides it; Groups reads the decision in its log by the settlement's id.
    const decided = await http.request('POST', `${api}/admin/settlements/${settlementId}/decision`, {
      body: { paid: true },
      token: admin.token,
    });
    expect((await outcome((decided.body as Body).operationId as string, admin.token)).body.status).toBe('SUCCESS');
    const log = await http.get(`${api}/admin/log`, { token: admin.token });
    expect(log.status).toBe(200);
    expect(
      (log.body as { subjectId: string; by: string; action: string }[]).filter(e => e.subjectId === settlementId),
    ).toEqual([
      { id: expect.any(String), at: expect.any(String), by: admin.id, action: 'decided-paid', subjectId: settlementId },
    ]);
  });
});
