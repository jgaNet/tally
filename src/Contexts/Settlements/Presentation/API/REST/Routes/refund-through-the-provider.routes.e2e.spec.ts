import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'shared-with-the-provider-for-refunds';

/**
 * A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment and `201 { id }` to a refund, and records
 * what it was asked; it answers 500 to a refund while `refusingRefunds` is set.
 */
let provider: Server;
const asked: { reference: string; amount: number; currency: string }[] = [];
let refundsAsked: { paymentId: string; reference: string }[] = [];
let refusingRefunds = false;
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
      const refund = /^\/payments\/([^/]+)\/refunds$/.exec(req.url ?? '');
      if (req.method === 'POST' && refund) {
        const body = JSON.parse(data) as { reference: string };
        refundsAsked.push({ paymentId: decodeURIComponent(refund[1]), reference: body.reference });
        if (refusingRefunds) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `refund-${refund[1]}` }));
        return;
      }
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
      counter++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `prov-${counter}`, payUrl: `https://pay.example/prov-${counter}` }));
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
    body: { email: 'refund-provider-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `refund-provider-${name.toLowerCase()}-${++accountCount}@example.com`;
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
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

/** The payee asks for a refund of a settlement, and follows it to its outcome. */
async function refund(token: string, settlementId: string) {
  const answer = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token });
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

async function settlementStatus(id: string, token: string) {
  const read = await http.get(`${api}/settlements/${id}`, { token });
  return (read.body as Body).status;
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

describe('Settlements: a payment through the provider is refunded whole by its payee, and the balances go back once the provider says so', () => {
  it('refunds a paid settlement through the provider, and the balances go back once the provider says it is refunded', async () => {
    const { ann, bob, groupId } = await owing('Refund');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    const providerId = `prov-${counter}`;
    await webhook({ id: 'wh-refund-1', paymentId: providerId, status: 'succeeded', at: '2026-11-17T10:00:00Z' });
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    refundsAsked = [];

    const asked = await refund(ann.token, id);
    expect(asked.status).toBe('SUCCESS');
    expect(refundsAsked).toEqual([{ paymentId: providerId, reference: id }]);
    expect(await settlementStatus(id, bob.token)).toBe('refunding');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });

    const told = await webhook({
      id: 'wh-refund-2',
      paymentId: providerId,
      status: 'refunded',
      at: '2026-11-17T11:00:00Z',
    });
    expect(told.status).toBe(202);
    expect(await settlementStatus(id, bob.token)).toBe('refunded');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });

  it('refuses a refund by anyone but the payee, and one by no one signed in, and changes nothing', async () => {
    const { ann, bob, groupId } = await owing('NotPayee');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    await webhook({ id: 'wh-np-1', paymentId: `prov-${counter}`, status: 'succeeded', at: '2026-11-17T10:00:00Z' });

    const byPayer = await refund(bob.token, id);
    expect(byPayer.status).toBe('ERROR');
    expect((byPayer.body.error as { type: string }).type).toBe('NotThePayee');
    const anonymous = await http.request('POST', `${api}/settlements/${id}/refund`);
    expect(anonymous.status).toBe(401);

    expect(await settlementStatus(id, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });

  it('refuses a refund the provider does not accept, and keeps the settlement paid', async () => {
    const { ann, bob, groupId } = await owing('Refused');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    await webhook({ id: 'wh-rf-1', paymentId: `prov-${counter}`, status: 'succeeded', at: '2026-11-17T10:00:00Z' });

    refusingRefunds = true;
    const answer = await refund(ann.token, id);
    refusingRefunds = false;

    expect(answer.status).toBe('ERROR');
    expect((answer.body.error as { type: string }).type).toBe('RefundUnavailable');
    expect(await settlementStatus(id, bob.token)).toBe('paid');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });

  it('refuses a refund of a settlement in cash, which is not refunded through Tally', async () => {
    const { ann, bob, groupId } = await owing('Cash');
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 30 },
      token: ann.token,
    });
    const done = await outcome((answer.body as Body).operationId as string, ann.token);
    const id = (done.body as { result: { id: string } }).result.id;

    const cashRefund = await refund(ann.token, id);

    expect(cashRefund.status).toBe('ERROR');
    expect((cashRefund.body.error as { type: string }).type).toBe('CashSettlementNotRefundable');
  });

  it('refuses a refund once the payer has left the group, so the balances still add up to 0', async () => {
    const { ann, bob, groupId } = await owing('Left');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    await webhook({ id: 'wh-left-1', paymentId: `prov-${counter}`, status: 'succeeded', at: '2026-11-17T10:00:00Z' });
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect((await outcome((left.body as Body).operationId as string, bob.token)).body.status).toBe('SUCCESS');

    const answer = await refund(ann.token, id);

    expect(answer.status).toBe('ERROR');
    expect((answer.body.error as { type: string }).type).toBe('PayerNotAMember');
    expect(await settlementStatus(id, ann.token)).toBe('paid');
  });

  it('counts a refund that overtakes the success of the same payment as refunded, never paid', async () => {
    const { ann, bob, groupId } = await owing('Overtake');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    const providerId = `prov-${counter}`;

    await webhook({ id: 'wh-ot-1', paymentId: providerId, status: 'refunded', at: '2026-11-17T10:00:00Z' });
    await webhook({ id: 'wh-ot-2', paymentId: providerId, status: 'succeeded', at: '2026-11-17T10:00:01Z' });

    expect(await settlementStatus(id, bob.token)).toBe('refunded');
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });
});

describe('Groups → Settlements (SettlementMembers): the refund is of the settlement in the group Groups made, by the id its request answered', () => {
  it('refunds the settlement by the id its payment answered, in the group whose id its creation answered, for its members only', async () => {
    const { ann, bob, groupId } = await owing('GroupRefund');
    const paid = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 30 });
    const id = (paid.body.result as { id: string }).id;
    await webhook({ id: 'wh-gr-1', paymentId: `prov-${counter}`, status: 'succeeded', at: '2026-11-17T10:00:00Z' });
    const stranger = await person('GroupRefundStranger');

    const refusedToStranger = await refund(stranger.token, id);
    expect(refusedToStranger.status).toBe('ERROR');
    expect(await settlementStatus(id, ann.token)).toBe('paid');

    const answer = await refund(ann.token, id);
    expect(answer.status).toBe('SUCCESS');
    const read = await http.get(`${api}/settlements/${id}`, { token: ann.token });
    expect((read.body as Body).groupId).toBe(groupId);
    expect((read.body as Body).status).toBe('refunding');
  });
});
