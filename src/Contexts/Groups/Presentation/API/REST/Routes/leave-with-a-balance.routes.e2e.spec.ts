import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider-leave';

/** A stand-in for the payment provider: it knows the accounts that start with `acct-`, and answers a payment with a link. */
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
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: `leave-prov-${counter}`, payUrl: `https://pay.example/leave-prov-${counter}`, fee: 0 }),
      );
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
    body: { email: 'leave-provider-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `leave-provider-${name.toLowerCase()}-${++accountCount}@example.com`;
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

/** Records an expense, and answers when it is recorded. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** The person sets the payout account the provider knows (request 16). */
async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  return outcome((answer.body as Body).operationId as string, token);
}

/** A member asks to leave, and answers the outcome of the request. */
async function leave(groupId: string, member: { token: string }) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: member.token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, member.token);
  return { status: done.status, body: done.body };
}

/** Sends the provider's webhook, signed as the provider signs it. */
async function webhook(payload: Body) {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': signature },
  });
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30; Bob then pays her through the provider. */
async function bobPaysAnnThroughTheProvider() {
  const ann = await person('Ann');
  await setPayoutAccount(ann.token, `acct-${ann.id}`);
  const bob = await person('Bob');
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 60,
    date: serverToday,
    splitBetween: [ann.id, bob.id],
  });
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: ann.id, amount: 30 },
    token: bob.token,
  });
  const paid = await outcome((answer.body as Body).operationId as string, bob.token);
  const settlementId = (paid.body.result as { id: string }).id;
  return { ann, bob, groupId, settlementId };
}

describe('Groups → Settlements → Groups: a member leaves once no payment of theirs waits at the provider (WaitingPayments)', () => {
  it('refuses the leave while a payment through the provider is pending, and lets it leave once the provider says it succeeded', async () => {
    const { ann, bob, groupId, settlementId } = await bobPaysAnnThroughTheProvider();
    const read = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(read.body).toMatchObject({ status: 'pending' });

    expect((await leave(groupId, bob)).body).toMatchObject({
      status: 'ERROR',
      error: { type: 'PaymentWaitingAtProvider' },
    });

    const told = await webhook({
      id: 'leave-wh-1',
      paymentId: `leave-prov-${counter}`,
      status: 'succeeded',
      at: '2026-11-17T10:00:00Z',
    });
    expect((await outcome((told.body as Body).operationId as string)).body.status).toBe('SUCCESS');
    expect((await leave(groupId, bob)).body).toMatchObject({ status: 'SUCCESS' });

    // Bob's balance was -30 and the payment paid it: 0 passed to Ann, and the group's balances add up to 0.
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(balances.body).toEqual([{ memberId: ann.id, balance: 0 }]);
  });
});
