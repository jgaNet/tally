import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider';

/**
 * A stand-in for the payment provider: it answers `201 { id, payUrl, fee }` to a payment, with the fee the test set (or no fee at
 * all, when `feeAnswer` is `absent`), and knows the accounts `acct-…` (request 16, request 38).
 */
let provider: Server;
let feeAnswer: number | 'absent' = 0;
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
      const fee = feeAnswer === 'absent' ? {} : { fee: feeAnswer };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `fee-${counter}`, payUrl: `https://pay.example/fee-${counter}`, ...fee }));
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
    body: { email: 'provider-fee-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `provider-fee-${name.toLowerCase()}-${++accountCount}@example.com`;
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

/** The person sets the payout account the provider knows, and follows it to its outcome (request 16). */
async function setPayoutAccount(token: string, accountId: string) {
  const answer = await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** Sends the provider's webhook, signed as the provider signs it. */
async function webhook(payload: Body) {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': signature },
  });
}

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

/** Ann paid 60 for dinner, split with Bob: Bob owes Ann 30; Ann has a payout account at the provider. */
async function owing(name: string) {
  const ann = await person(`${name}Ann`);
  const bob = await person(`${name}Bob`);
  await setPayoutAccount(ann.token, 'acct-ann');
  const groupId = await createGroup(ann);
  await join(groupId, ann, bob);
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: serverToday, splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  await outcome((recorded.body as Body).operationId as string, ann.token);
  return { ann, bob, groupId };
}

/** Asks Bob to pay Ann through the provider, and follows it to its outcome. */
async function payAnn(bob: { token: string }, groupId: string, annId: string, amount: number) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: annId, amount },
    token: bob.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, bob.token);
  return done.body as Body;
}

describe('Settlements: who bears the provider fee (request 38)', () => {
  it('reads the payee as the one who bears the fee until the owner decides, and refuses a non-member', async () => {
    const { ann, bob, groupId } = await owing('Default');
    const read = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ borneBy: 'payee' });

    const stranger = await person('DefaultStranger');
    const refused = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: stranger.token });
    expect(refused.status).toBe(404);
    expect(ann.id).toBeTruthy();
  });

  it('lets only the owner decide who bears the fee: a member is refused, and the owner decides', async () => {
    const { ann, bob, groupId } = await owing('Policy');
    const byMember = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: bob.token,
    });
    expect(byMember.status).toBe(202);
    const refused = await outcome((byMember.body as Body).operationId as string, bob.token);
    expect((refused.body as { status: string }).status).toBe('ERROR');
    expect((refused.body as { error: { type: string } }).error.type).toBe('OnlyTheOwnerSetsFeePolicy');

    const byOwner = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: ann.token,
    });
    const decided = await outcome((byOwner.body as Body).operationId as string, ann.token);
    expect((decided.body as { status: string }).status).toBe('SUCCESS');
    const read = await http.get(`${api}/groups/${groupId}/fee-policy`, { token: bob.token });
    expect(read.body).toEqual({ borneBy: 'payer' });
  });

  it('settles a payment through the provider less the part the payer bears, and reads the fee it was asked with', async () => {
    const { ann, bob, groupId } = await owing('Settles');
    const policy = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: ann.token,
    });
    await outcome((policy.body as Body).operationId as string, ann.token);

    feeAnswer = 3;
    const paid = await payAnn(bob, groupId, ann.id, 30);
    expect(paid.status).toBe('SUCCESS');
    const settlementId = (paid.result as { id: string }).id;
    const read = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(read.body).toMatchObject({
      amount: 30,
      method: 'provider',
      status: 'pending',
      fee: { amount: 3, borneBy: 'payer' },
    });

    const told = await webhook({
      id: 'evt-settles',
      paymentId: `fee-${counter}`,
      status: 'succeeded',
      at: '2026-11-01T10:00:00Z',
    });
    expect(told.status).toBe(202);
    const after = await balances(groupId, bob.token);
    // Bob owes 30 less the 27 settled: the 3 of the fee he bears is still owed.
    expect(after[bob.id]).toBe(-3);
    expect(after[ann.id]).toBe(3);
  });

  it('refuses a provider answer without a fee, and keeps nothing', async () => {
    const { ann, bob, groupId } = await owing('NoFee');
    feeAnswer = 'absent';
    const paid = await payAnn(bob, groupId, ann.id, 30);
    expect(paid.status).toBe('ERROR');
    expect((paid.error as { type: string }).type).toBe('ProviderUnavailable');
    const kept = await http.get(`${api}/groups/${groupId}/settlements`, { token: bob.token });
    expect(kept.body).toEqual([]);
  });

  it('refuses a fee not less than the amount, and keeps nothing', async () => {
    const { ann, bob, groupId } = await owing('TooHigh');
    feeAnswer = 30;
    const paid = await payAnn(bob, groupId, ann.id, 30);
    expect(paid.status).toBe('ERROR');
    expect((paid.error as { type: string }).type).toBe('ProviderFeeOutOfRange');
    const kept = await http.get(`${api}/groups/${groupId}/settlements`, { token: bob.token });
    expect(kept.body).toEqual([]);
  });
});
