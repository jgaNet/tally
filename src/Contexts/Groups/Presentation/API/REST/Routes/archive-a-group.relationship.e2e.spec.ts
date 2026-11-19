import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/** A stand-in for the payment provider, so a settlement can wait at it (request 13): it answers a payment with an id and a link. */
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
      if (req.method === 'GET' && (req.url ?? '').startsWith('/accounts/acct-')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: decodeURIComponent((req.url ?? '').slice('/accounts/'.length)) }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `rel-${counter}`, payUrl: `https://pay.example/rel-${counter}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = 'archive-relationship-secret';

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  // The server's date, read from an operation it answers: the application has one clock.
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'archive-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((probeSignUp.body as Body).operationId as string);
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

/** Asks for a command and follows it to its outcome. */
async function send(method: string, path: string, token: string, body?: unknown) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body };
}

let accountCount = 0;

async function person(name: string, payoutAccount?: string) {
  const email = `${name.toLowerCase()}-archive-rel-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  const id = (me.body as { id: string }).id;
  if (payoutAccount) await send('PUT', '/accounts/me/payout-account', token, { accountId: payoutAccount });
  return { token, id };
}

/** Creates a group and answers the id Groups gave it. */
async function createGroup(owner: { token: string }) {
  const { done } = await send('POST', '/groups', owner.token, { name: 'Flat', currency: 'EUR' });
  return (done as { result: { id: string } }).result.id;
}

/** The owner invites the other person, who accepts: a member of the group from then on. */
async function joinGroup(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const { done } = await send('POST', `/groups/${groupId}/invitations`, owner.token);
  const invitationId = (done as { result: { id: string } }).result.id;
  await send('POST', `/invitations/${invitationId}/accept`, joiner.token);
}

/** The owner and the other member share one expense of 100 equally; answers its id. */
async function shareExpense(groupId: string, owner: { token: string; id: string }, other: { id: string }) {
  const { done } = await send('POST', `/groups/${groupId}/expenses`, owner.token, {
    description: 'Dinner',
    amount: 100,
    date: serverToday,
    splitBetween: [owner.id, other.id],
  });
  return (done as { result: { id: string } }).result.id;
}

describe('Groups → Ledger (GroupMembers): a group Groups makes is the one its expenses are kept in, by the id it answered', () => {
  it('records an expense in the group by the group id Groups answered, and reads it back by that id', async () => {
    const ann = await person('Ann');
    const groupId = await createGroup(ann);

    const bob = await person('Bob');
    await joinGroup(groupId, ann, bob);
    const expenseId = await shareExpense(groupId, ann, bob);

    const listed = await http.get(`${api}/groups/${groupId}/expenses`, { token: ann.token });
    expect((listed.body as Body[]).map(entry => entry.id)).toEqual([expenseId]);
    const read = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect(read.body).toMatchObject({ groupId, paidBy: ann.id, amount: 100 });
  });
});

describe('Groups → Settlements (SettlementMembers): a group Groups makes is the one its settlements are decided in, by the id it answered', () => {
  it('records a cash settlement in the group by the group id Groups answered, and reads it back by that id', async () => {
    const ann = await person('Cy');
    const bob = await person('Dee');
    const groupId = await createGroup(ann);
    await joinGroup(groupId, ann, bob);
    await shareExpense(groupId, ann, bob);

    const settled = await send('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: bob.id, amount: 50 });
    const settlementId = (settled.done as { result: { id: string } }).result.id;

    const listed = await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(listed.body as Body[]).toEqual([expect.objectContaining({ id: settlementId, groupId, status: 'paid' })]);
  });
});

describe('Ledger → Groups (MemberBalances): an expense Ledger keeps is a balance Groups reads, by the group id it answers', () => {
  it('refuses the archive while the expense leaves a balance, and archives once a cash settlement clears it', async () => {
    const ann = await person('Eve');
    const bob = await person('Fay');
    const groupId = await createGroup(ann);
    await joinGroup(groupId, ann, bob);
    await shareExpense(groupId, ann, bob);

    const early = await send('POST', `/groups/${groupId}/archive`, ann.token);
    expect((early.done?.error as { type: string }).type).toBe('GroupNotSettled');

    await send('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: bob.id, amount: 50 });
    const archived = await send('POST', `/groups/${groupId}/archive`, ann.token);
    expect(archived.done).toMatchObject({ status: 'SUCCESS' });
    const read = await http.get(`${api}/groups/${groupId}`, { token: ann.token });
    expect(read.body).toHaveProperty('archivedAt');
  });
});

describe('Settlements → Groups (WaitingPayments): a payment Settlements keeps at the provider is one Groups reads, by the group id it answers', () => {
  it('refuses the archive while a payment waits at the provider, and reads the group open by its id', async () => {
    const ann = await person('Gus', 'acct-gus');
    const bob = await person('Hal');
    const groupId = await createGroup(ann);
    await joinGroup(groupId, ann, bob);
    await shareExpense(groupId, ann, bob);

    const paid = await send('POST', `/groups/${groupId}/settlements/provider`, bob.token, { to: ann.id, amount: 50 });
    const settlementId = (paid.done as { result: { id: string } }).result.id;
    expect(settlementId).toBeTruthy();

    const refused = await send('POST', `/groups/${groupId}/archive`, ann.token);
    expect((refused.done?.error as { type: string }).type).toBe('GroupNotSettled');
    const listed = await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(listed.body as Body[]).toEqual([expect.objectContaining({ id: settlementId, groupId, status: 'pending' })]);
    const read = await http.get(`${api}/groups/${groupId}`, { token: ann.token });
    expect(read.body).not.toHaveProperty('archivedAt');
  });
});
