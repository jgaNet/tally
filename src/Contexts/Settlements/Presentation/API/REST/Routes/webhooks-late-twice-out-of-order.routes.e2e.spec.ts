import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider';

/** A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment, and records what it was asked. */
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
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      JSON.parse(data);
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `late-${counter}`, payUrl: `https://pay.example/late-${counter}` }));
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
    body: { email: 'late-webhooks-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `late-webhooks-${name.toLowerCase()}-${++accountCount}@example.com`;
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

/** Asks to pay another member through the provider, and follows it to its outcome. */
async function payThroughProvider(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
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

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

async function statusOf(settlementId: string, token: string) {
  const read = await http.get(`${api}/settlements/${settlementId}`, { token });
  return (read.body as Body).status;
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30, and Bob asks to pay it through the provider. */
async function owingAndPaying(name: string) {
  const ann = await person(`${name}Ann`);
  const bob = await person(`${name}Bob`);
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 60,
    date: serverToday,
    splitBetween: [ann.id, bob.id],
  });
  const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
  const settlementId = (paid.body.result as { id: string }).id;
  return { ann, bob, groupId, settlementId, paymentId: `late-${counter}` };
}

const at = '2026-11-17T10:00:00Z';

describe('Settlements: a webhook said twice changes a payment once', () => {
  it('counts a payment once when the same webhook is sent twice, and once when two webhooks under two ids say the same', async () => {
    const { ann, bob, groupId, settlementId, paymentId } = await owingAndPaying('Twice');

    const first = { id: 'wh-twice-1', paymentId, status: 'succeeded', at };
    expect((await webhook(first)).status).toBe(202);
    expect((await webhook(first)).status).toBe(202);
    expect((await webhook({ ...first, id: 'wh-twice-2' })).status).toBe(202);

    expect(await statusOf(settlementId, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });
});

describe('Settlements: a webhook out of order changes nothing the settlement has already passed', () => {
  it('leaves a paid payment paid when a pending word arrives after the succeeded one', async () => {
    const { ann, bob, groupId, settlementId, paymentId } = await owingAndPaying('Reversed');

    await webhook({ id: 'wh-rev-1', paymentId, status: 'succeeded', at });
    const late = await webhook({ id: 'wh-rev-2', paymentId, status: 'pending', at });

    expect(late.status).toBe(202);
    expect(await statusOf(settlementId, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });

  it('leaves a failed payment failed when a succeeded word overtakes it, and keeps what it freed', async () => {
    const { ann, bob, groupId, settlementId, paymentId } = await owingAndPaying('Overtaken');

    await webhook({ id: 'wh-ot-1', paymentId, status: 'failed', at });
    expect((await webhook({ id: 'wh-ot-2', paymentId, status: 'succeeded', at })).status).toBe(202);

    expect(await statusOf(settlementId, bob.token)).toBe('failed');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });
});

describe('Settlements: a webhook that arrives at the same moment as another counts once', () => {
  it('counts a payment once when the same webhook reaches the server twice at once', async () => {
    const { ann, bob, groupId, settlementId, paymentId } = await owingAndPaying('Simultaneous');
    const payload = { id: 'wh-sim-1', paymentId, status: 'succeeded', at };

    const answers = await Promise.all([webhook(payload), webhook(payload), webhook(payload)]);

    expect(answers.map(answer => answer.status)).toEqual([202, 202, 202]);
    expect(await statusOf(settlementId, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });
});

describe('Settlements: a webhook that arrives late still changes what it would have changed', () => {
  it('counts a payment whose webhook was decided days before it arrived', async () => {
    const { ann, bob, groupId, settlementId, paymentId } = await owingAndPaying('Late');

    const days = await webhook({ id: 'wh-late-1', paymentId, status: 'succeeded', at: '2026-11-10T08:00:00Z' });

    expect(days.status).toBe(202);
    expect(await statusOf(settlementId, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });
});

describe('Settlements: every signed webhook is acknowledged, whatever it changes', () => {
  it('acknowledges a repeated, reversed or pending webhook with 202, and a payment Tally does not know too', async () => {
    const { paymentId } = await owingAndPaying('Acknowledged');

    const words = [
      { id: 'wh-ack-1', paymentId, status: 'pending', at },
      { id: 'wh-ack-2', paymentId, status: 'succeeded', at },
      { id: 'wh-ack-3', paymentId, status: 'succeeded', at },
      { id: 'wh-ack-4', paymentId: 'nobody', status: 'failed', at },
    ];
    for (const word of words) expect((await webhook(word)).status).toBe(202);
  });
});
