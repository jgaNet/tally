import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider-for-history';

/** A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment, `201 { id }` to a refund, and knows `acct-` accounts. */
let provider: Server;
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
        const accountId = decodeURIComponent((req.url ?? '').slice('/accounts/'.length));
        if (!accountId.startsWith('acct-')) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: accountId }));
        return;
      }
      const refund = /^\/payments\/([^/]+)\/refunds$/.exec(req.url ?? '');
      if (req.method === 'POST' && refund) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `refund-${refund[1]}` }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      JSON.parse(data);
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `hist-${counter}`, payUrl: `https://pay.example/hist-${counter}`, fee: 0 }));
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
    body: { email: 'settlement-history-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
});

type Body = Record<string, unknown>;
type Line = { status: string; at: string };

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
  const email = `settlement-history-${name.toLowerCase()}-${++accountCount}@example.com`;
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

/** Records an expense the caller paid, split between the members named. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** Records a cash settlement as its payee, and answers the settlement's id. */
async function settleInCash(payee: { token: string }, groupId: string, from: string, amount: number) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
    body: { from, amount },
    token: payee.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, payee.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** Asks to pay another member through the provider, and answers the settlement's id. */
async function payThroughProvider(payer: { token: string }, groupId: string, to: string, amount: number) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to, amount },
    token: payer.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, payer.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** Sends the provider's webhook, signed as the provider signs it. */
async function webhook(payload: Body) {
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': sign(payload) },
  });
}

function sign(payload: Body): string {
  return createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
}

/** The payee asks the provider to refund a settlement, and follows it to its outcome. */
async function refund(payee: { token: string }, settlementId: string) {
  const answer = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: payee.token });
  await outcome((answer.body as Body).operationId as string, payee.token);
}

/** A member asks to leave, and follows it to its outcome. */
async function leave(groupId: string, member: { token: string }) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: member.token });
  return outcome((answer.body as Body).operationId as string, member.token);
}

async function listed(groupId: string, token: string) {
  return http.get(`${api}/groups/${groupId}/settlements`, { token });
}

/** The statuses of a settlement's history, the earliest first, as the settlement reads them. */
async function historyOf(settlementId: string, token: string): Promise<Line[]> {
  const read = await http.get(`${api}/settlements/${settlementId}`, { token });
  return (read.body as { history: Line[] }).history;
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30. Ann has a payout account the provider knows. */
async function owing(name: string) {
  const ann = await person(`${name}Ann`);
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, {
    body: { accountId: `acct-${ann.id}` },
    token: ann.token,
  });
  await outcome((answer.body as Body).operationId as string, ann.token);
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

const at = '2026-11-17T10:00:00Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

describe('Settlements: a group lists its settlements, the most recent first, each with its history (request 19)', () => {
  it('lists a cash and a provider settlement, the provider one first, each with every status it has had', async () => {
    const { ann, bob, groupId } = await owing('Order');
    const cashId = await settleInCash(ann, groupId, bob.id, 10);
    const providerId = await payThroughProvider(bob, groupId, ann.id, 20);

    const before = await listed(groupId, bob.token);
    expect(before.status).toBe(200);
    expect((before.body as { id: string }[]).map(settlement => settlement.id)).toEqual([providerId, cashId]);

    await webhook({ id: 'wh-order-1', paymentId: `hist-${counter}`, status: 'succeeded', at });
    const after = await listed(groupId, ann.token);
    const [provider, cash] = after.body as { id: string; history: Line[] }[];
    expect(provider).toMatchObject({ id: providerId });
    expect(provider.history.map(line => line.status)).toEqual(['pending', 'paid']);
    expect(cash).toMatchObject({ id: cashId, history: [{ status: 'paid' }] });
    for (const line of [...provider.history, ...cash.history]) expect(line.at).toMatch(ISO);
    expect(await historyOf(providerId, bob.token)).toEqual(provider.history);
  });

  it('a refund of a settlement paid through the provider adds refunding, then refunded', async () => {
    const { ann, bob, groupId } = await owing('Refund');
    const id = await payThroughProvider(bob, groupId, ann.id, 30);
    await webhook({ id: 'wh-hist-refund-1', paymentId: `hist-${counter}`, status: 'succeeded', at });
    await refund(ann, id);
    expect((await historyOf(id, ann.token)).map(line => line.status)).toEqual(['pending', 'paid', 'refunding']);

    await webhook({ id: 'wh-hist-refund-2', paymentId: `hist-${counter}`, status: 'refunded', at });
    expect((await historyOf(id, ann.token)).map(line => line.status)).toEqual([
      'pending',
      'paid',
      'refunding',
      'refunded',
    ]);
  });

  it('a webhook that changes nothing adds nothing to the history', async () => {
    const { ann, bob, groupId } = await owing('Nothing');
    const id = await payThroughProvider(bob, groupId, ann.id, 30);
    const paymentId = `hist-${counter}`;
    await webhook({ id: 'wh-nothing-1', paymentId, status: 'succeeded', at });
    await webhook({ id: 'wh-nothing-2', paymentId, status: 'succeeded', at });
    await webhook({ id: 'wh-nothing-3', paymentId, status: 'pending', at });

    expect((await historyOf(id, bob.token)).map(line => line.status)).toEqual(['pending', 'paid']);
  });

  it('a payment that fails has pending, then failed', async () => {
    const { ann, bob, groupId } = await owing('Failed');
    const id = await payThroughProvider(bob, groupId, ann.id, 30);
    await webhook({ id: 'wh-failed-1', paymentId: `hist-${counter}`, status: 'failed', at });

    expect((await historyOf(id, bob.token)).map(line => line.status)).toEqual(['pending', 'failed']);
  });

  it('answers the group to its members only: anyone else sees no group, and no one signed in is refused', async () => {
    const { groupId } = await owing('Outsider');
    const outsider = await person('OutsiderStranger');

    const stranger = await listed(groupId, outsider.token);
    expect(stranger.status).toBe(404);
    const anonymous = await http.get(`${api}/groups/${groupId}/settlements`);
    expect(anonymous.status).toBe(401);
  });

  it('keeps a settlement listed for the members after its payer has left the group', async () => {
    const { ann, bob, groupId } = await owing('Left');
    const id = await settleInCash(ann, groupId, bob.id, 30);
    const left = await leave(groupId, bob);
    expect(left.body).toMatchObject({ status: 'SUCCESS' });

    const seen = await listed(groupId, ann.token);
    expect(seen.status).toBe(200);
    expect(seen.body as { id: string; from: string }[]).toEqual([
      expect.objectContaining({ id, from: bob.id, history: [expect.objectContaining({ status: 'paid' })] }),
    ]);
    const formerMember = await listed(groupId, bob.token);
    expect(formerMember.status).toBe(404);
  });
});

describe('Groups → Settlements (SettlementMembers): the group Groups made is the one Settlements lists, by the id its request answered', () => {
  it('lists the settlements of the group made through the API by the id its request answered, and none of another group', async () => {
    const { ann, bob, groupId } = await owing('GroupsLink');
    const settlementId = await settleInCash(ann, groupId, bob.id, 10);
    const otherGroupId = await createGroup(ann);

    const here = await listed(groupId, ann.token);
    expect(here.status).toBe(200);
    expect(here.body).toEqual([expect.objectContaining({ id: settlementId, groupId })]);
    const there = await listed(otherGroupId, ann.token);
    expect(there.status).toBe(200);
    expect(there.body).toEqual([]);
  });
});
