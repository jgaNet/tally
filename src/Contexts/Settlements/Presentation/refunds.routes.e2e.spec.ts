import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-refunds-${randomUUID()}.db`);

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';

/**
 * The payment provider, as a server of its own: it answers `POST /payments` with a link, and `POST /payments/{id}/refunds` with what the
 * test sets (by default `201 { id }`). It records what Tally asked of it.
 */
let refundAnswer: { status: number; body?: unknown } | undefined;
let refundRequests: Array<{ path: string; reference: string }> = [];
let paymentCount = 0;
let providerServer: Server;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => resolve(text));
  });

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    const text = await readBody(request);
    const path = request.url ?? '';
    if (request.method === 'POST' && path === '/payments') {
      paymentCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}` }));
      return;
    }
    const refund = /^\/payments\/([^/]+)\/refunds$/.exec(path);
    if (request.method === 'POST' && refund) {
      refundRequests.push({ path, reference: (JSON.parse(text) as { reference: string }).reference });
      const answer = refundAnswer ?? { status: 201, body: { id: `refund-${refundRequests.length}` } };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => providerServer.close(() => resolve()));
  delete process.env.PROVIDER_URL;
  delete process.env.PROVIDER_WEBHOOK_SECRET;
});
beforeEach(() => {
  refundAnswer = undefined;
  refundRequests = [];
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as Array<{
    memberId: string;
    balance: number;
  }>;

const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });

const refundOf = (id: string, token: string) => http.request('POST', `${api}/settlements/${id}/refund`, { token });

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hexadecimal. */
async function webhook(payload: { paymentId: string; status: string }): Promise<number> {
  const body = JSON.stringify({ id: randomUUID(), at: '2026-11-17T10:00:00Z', ...payload });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const response = await fetch(`${app.address}${api}/provider/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
    body,
  });
  return response.status;
}

/** Ann paid 100 for herself and Bob: Bob owes Ann 50. Returns the group and the two members. */
async function annAndBobOwing50(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const groupId = await groupWith(ann, [bob]);
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  return { groupId, ann, bob };
}

/** Bob pays Ann 50 through the provider, and the provider says it succeeded: returns the settlement's id and the provider's payment id. */
async function paidThroughProvider(label: string) {
  const { groupId, ann, bob } = await annAndBobOwing50(label);
  const created = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: ann.id, amount: 50 },
    token: bob.token,
  });
  const id = (created.body as { id: string }).id;
  const paymentId = `pay-${paymentCount}`;
  expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
  return { groupId, ann, bob, id, paymentId };
}

describe('refunding a settlement paid through the payment provider', () => {
  it('asks the provider to refund it for its payee, keeps it refunding and still counted, and the balances go back once it is refunded', async () => {
    const { groupId, ann, bob, id, paymentId } = await paidThroughProvider('refund-back');
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    const refunded = await refundOf(id, ann.token);
    expect(refunded.status).toBe(204);
    expect(refundRequests).toEqual([{ path: `/payments/${paymentId}/refunds`, reference: id }]);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'refunding' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    expect(await webhook({ paymentId, status: 'refunded' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'refunded' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 50 },
      { memberId: bob.id, balance: -50 },
    ]);
  });

  it('counts a refunded said twice once, and a success or a pending that comes after it changes nothing', async () => {
    const { groupId, ann, id, paymentId } = await paidThroughProvider('refund-twice');
    await refundOf(id, ann.token);
    expect(await webhook({ paymentId, status: 'refunded' })).toBe(204);
    expect(await webhook({ paymentId, status: 'refunded' })).toBe(204);
    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
    expect(await webhook({ paymentId, status: 'pending' })).toBe(204);
    expect((await readSettlement(id, ann.token)).body).toMatchObject({ status: 'refunded' });
    expect((await balancesOf(groupId, ann.token)).find(each => each.balance === 50)).toBeDefined();
  });

  it('lets a refunded that overtakes the success leave the settlement refunded, and never counted', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('refund-overtakes');
    const created = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 50 },
      token: bob.token,
    });
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;
    const before = await balancesOf(groupId, ann.token);

    expect(await webhook({ paymentId, status: 'refunded' })).toBe(204);
    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'refunded' });
    expect(await balancesOf(groupId, ann.token)).toEqual(before);
  });

  it('refuses a refund by the payer, a refund twice, and a cash settlement, and changes nothing', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('refund-refused');
    // Bob pays 10 in cash first, so that what he pays through the provider is the rest of his 50.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 10 },
      token: ann.token,
    });
    expect(cash.status).toBe(201);
    const refusedCash = await refundOf((cash.body as { id: string }).id, ann.token);
    expect(refusedCash.status).toBe(422);
    expect(refusedCash.body).toMatchObject({ type: 'SettlementNotRefundable' });

    const created = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 40 },
      token: bob.token,
    });
    const id = (created.body as { id: string }).id;
    expect(await webhook({ paymentId: `pay-${paymentCount}`, status: 'succeeded' })).toBe(204);

    expect((await refundOf(id, bob.token)).status).toBe(403);
    expect(refundRequests).toEqual([]);
    expect(await refundOf(id, ann.token).then(each => each.status)).toBe(204);
    expect((await refundOf(id, ann.token)).status).toBe(422);
    expect(refundRequests).toHaveLength(1);
  });

  it('refuses a refund when the provider does not accept it, and the settlement stays paid', async () => {
    const { groupId, ann, id } = await paidThroughProvider('refund-provider-no');
    refundAnswer = { status: 500, body: { message: 'down' } };
    const refused = await refundOf(id, ann.token);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'ProviderUnavailable' });
    expect((await readSettlement(id, ann.token)).body).toMatchObject({ status: 'paid' });
    expect((await balancesOf(groupId, ann.token)).find(each => each.balance === 0)).toBeDefined();
  });

  it('refuses a refund once the payer has left the group, so the balances of the group still add up to 0', async () => {
    const { groupId, ann, bob, id } = await paidThroughProvider('refund-payer-left');
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBe(204);
    const refused = await refundOf(id, ann.token);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'SettlementNotRefundable' });
    expect(refundRequests).toEqual([]);
  });

  it('does not show a settlement to a caller outside its group, and asks for a signed-in caller', async () => {
    const { ann, id } = await paidThroughProvider('refund-outsider');
    const stranger = await signedIn('refund-outsider-cy@example.com', 'Cy');
    expect((await refundOf(id, stranger.token)).status).toBe(404);
    expect((await http.request('POST', `${api}/settlements/${id}/refund`)).status).toBe(401);
    expect(refundRequests).toEqual([]);
    expect(ann.id).toBeDefined();
  });
});

describe('Groups → Settlements', () => {
  it('refunds a settlement between the members Groups made by the ids their sign-ups answered, found by the id its request answered', async () => {
    const { ann, bob, id, paymentId } = await paidThroughProvider('refund-groups-link');
    const read = await readSettlement(id, ann.token);
    expect(read.body).toMatchObject({ id, from: bob.id, to: ann.id, status: 'paid' });

    expect((await refundOf(id, ann.token)).status).toBe(204);
    expect(refundRequests).toEqual([{ path: `/payments/${paymentId}/refunds`, reference: id }]);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({
      id,
      from: bob.id,
      to: ann.id,
      status: 'refunding',
    });
  });
});
