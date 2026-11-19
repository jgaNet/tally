import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('webhooks');

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';

/** The payment provider as a server of its own: it answers `POST /payments` with a link, and counts what it was asked. */
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
    await readBody(request);
    if (request.method === 'POST' && request.url === '/payments') {
      paymentCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}`, fee: 0 }),
      );
      return;
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(request.url ?? '')) {
      const id = decodeURIComponent((request.url ?? '').slice('/accounts/'.length));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await database;
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

const balanceOf = async (groupId: string, memberId: string, token: string): Promise<number | undefined> =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as Array<{
      memberId: string;
      balance: number;
    }>
  ).find(each => each.memberId === memberId)?.balance;

const payThrough = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });

const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });

/**
 * The provider's webhook as the provider sends it: the body as text, signed with HMAC-SHA256 in lowercase hexadecimal. The same text
 * sent twice is the same webhook; a body with another id is another webhook about the same thing (request 14).
 */
async function sendWebhook(text: string): Promise<number> {
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(text).digest('hex');
  const response = await fetch(`${app.address}${api}/provider/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
    body: text,
  });
  return response.status;
}

const webhookText = (payload: { id?: string; paymentId: string; status: string }) =>
  JSON.stringify({ id: randomUUID(), at: '2026-11-17T10:00:00Z', ...payload });

/** Ann paid 100 for herself and Bob: Bob owes Ann 50. Returns the group, and the two members. */
async function annAndBobOwing50(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const groupId = await groupWith(ann, [bob]);
  // Ann is paid through the provider, so she has a payout account at it (request 16).
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    body: { accountId: `acct-${ann.id}` },
    token: ann.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  return { groupId, ann, bob };
}

/** Bob asks to pay Ann 50 through the provider; answers the settlement's id and the provider's payment id it waits on. */
async function bobPays50(groupId: string, ann: { id: string }, bob: { token: string }) {
  const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
  return { id: (created.body as { id: string }).id, paymentId: `pay-${paymentCount}` };
}

describe('webhooks that come twice, late, out of order or at once (request 14)', () => {
  it('counts a payment once when the same webhook comes twice: both are acknowledged, the balances move once', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('twice-same');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);
    const text = webhookText({ id: `wh-${randomUUID()}`, paymentId, status: 'succeeded' });

    expect(await sendWebhook(text)).toBe(204);
    expect(await sendWebhook(text)).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
    expect(await balanceOf(groupId, ann.id, ann.token)).toBe(0);
  });

  it('counts a payment once when two webhooks under two ids say the same thing about it', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('twice-two-ids');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
  });

  it('keeps a payment paid when a pending webhook arrives after its success', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('out-of-order-pending');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'pending' }))).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
  });

  it('keeps a payment paid when a failure arrives after its success: a payment ends once', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('out-of-order-failed');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'failed' }))).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
  });

  it('keeps a payment failed when a success or a pending arrives after its failure, and frees what it held', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('out-of-order-after-failure');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    expect(await sendWebhook(webhookText({ paymentId, status: 'failed' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'pending' }))).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'failed' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(-50);
    expect((await payThrough(groupId, bob.token, { to: ann.id, amount: 50 })).status).toBe(201);
  });

  it('counts a payment once when its webhooks reach the server at the same moment', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('same-moment');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    const statuses = await Promise.all(
      [1, 2, 3, 4, 5].map(() => sendWebhook(webhookText({ paymentId, status: 'succeeded' }))),
    );

    expect(statuses).toEqual([204, 204, 204, 204, 204]);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
  });

  it('acknowledges every signed webhook with 2xx, including one that changes nothing', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('always-acknowledged');
    const { id, paymentId } = await bobPays50(groupId, ann, bob);

    expect(await sendWebhook(webhookText({ paymentId, status: 'pending' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'chargeback' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId: 'pay-never-asked', status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);
    expect(await sendWebhook(webhookText({ paymentId, status: 'succeeded' }))).toBe(204);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect(await balanceOf(groupId, bob.id, bob.token)).toBe(0);
  });
});
