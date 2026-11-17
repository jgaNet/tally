import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { randomUUID, createHmac } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-history-${randomUUID()}.db`);

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';

/**
 * The payment provider, as a server of its own: it answers `POST /payments` with a link, `POST /payments/{id}/refunds` with a refund, and
 * `GET /accounts/{id}` with the account, as request 16 asks. Each payment it makes is named `pay-{n}`, its link `https://pay.example/pay-{n}`.
 */
let providerServer: Server;
let providerOrigin: string;
let paymentCount = 0;

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
    const url = request.url ?? '';
    if (request.method === 'POST' && url === '/payments') {
      paymentCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}` }));
      return;
    }
    if (request.method === 'POST' && /^\/payments\/[^/]+\/refunds$/.test(url)) {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `refund-of-${text.length}` }));
      return;
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(url)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(url.slice('/accounts/'.length)) }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

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

/** Ann paid 100 for herself and Bob, who owes her 50; Ann has a payout account at the provider. Returns the group and the two members. */
async function annAndBobOwing50(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const groupId = await groupWith(ann, [bob]);
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

const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const listSettlements = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/settlements`, { token });

/** Bob pays Ann through the provider, and the settlement's payment is the provider's `pay-n` its link names. */
async function pendingThroughProvider(
  groupId: string,
  bob: { token: string; id: string },
  ann: { id: string },
  amount: number,
) {
  const requested = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: ann.id, amount },
    token: bob.token,
  });
  const id = (requested.body as { id: string }).id;
  const settlement = (await readSettlement(id, bob.token)).body as { payUrl: string };
  return { id, paymentId: settlement.payUrl.split('/').pop() as string };
}

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

/** The statuses a settlement has had, in the order they were had, read from the settlement itself. */
async function historyOf(id: string, token: string): Promise<string[]> {
  const read = (await readSettlement(id, token)).body as { history: Array<{ status: string; at: string }> };
  return read.history.map(line => line.status);
}

describe("a group's settlements, each with every status it has had", () => {
  it('lists the settlements, the most recent first, each with its statuses the earliest first, and no webhook that changes nothing adds one', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hist-list');
    const throughProvider = await pendingThroughProvider(groupId, bob, ann, 20);
    expect(await listSettlements(groupId, ann.token).then(each => each.status)).toBe(200);

    // Ann records a cash payment of 10 from Bob, after the provider's one: the most recent first.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 10 },
      token: ann.token,
    });
    const cashId = (cash.body as { id: string }).id;

    expect(await webhook({ paymentId: throughProvider.paymentId, status: 'succeeded' })).toBe(204);
    // A repeated, or a pending, webhook changes nothing, so it adds nothing to the history.
    expect(await webhook({ paymentId: throughProvider.paymentId, status: 'succeeded' })).toBe(204);
    expect(await webhook({ paymentId: throughProvider.paymentId, status: 'pending' })).toBe(204);

    const listed = await listSettlements(groupId, bob.token);
    expect(listed.status).toBe(200);
    const settlements = listed.body as Array<{
      id: string;
      status: string;
      history: Array<{ status: string; at: string }>;
    }>;
    expect(settlements.map(each => each.id)).toEqual([cashId, throughProvider.id]);
    expect(settlements[0]).toMatchObject({ id: cashId, status: 'paid' });
    expect(settlements[0].history.map(line => line.status)).toEqual(['paid']);
    expect(settlements[1]).toMatchObject({ id: throughProvider.id, status: 'paid' });
    expect(settlements[1].history.map(line => line.status)).toEqual(['pending', 'paid']);
    expect(settlements[1].history.every(line => /^\d{4}-\d{2}-\d{2}T/.test(line.at))).toBe(true);

    // The settlement as GET /settlements/{id} reads it, with the same history.
    expect((await readSettlement(throughProvider.id, bob.token)).body).toMatchObject({
      id: throughProvider.id,
      history: settlements[1].history,
    });
  });

  it('a payment a webhook moves past a status it never had adds only the status it moves to', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hist-jump');
    const settled = await pendingThroughProvider(groupId, bob, ann, 20);

    // The provider says the payment was refunded before it says it succeeded: the history has pending, then refunded only.
    expect(await webhook({ paymentId: settled.paymentId, status: 'refunded' })).toBe(204);
    expect(await historyOf(settled.id, ann.token)).toEqual(['pending', 'refunded']);
  });

  it('a payment that failed is pending, then failed', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hist-failed');
    const settled = await pendingThroughProvider(groupId, bob, ann, 20);

    expect(await webhook({ paymentId: settled.paymentId, status: 'failed' })).toBe(204);
    expect(await historyOf(settled.id, ann.token)).toEqual(['pending', 'failed']);
  });

  it('a paid settlement is refunding, then refunded once the provider says so', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hist-refund');
    const settled = await pendingThroughProvider(groupId, bob, ann, 20);
    expect(await webhook({ paymentId: settled.paymentId, status: 'succeeded' })).toBe(204);

    expect((await http.request('POST', `${api}/settlements/${settled.id}/refund`, { token: ann.token })).status).toBe(
      204,
    );
    expect(await historyOf(settled.id, bob.token)).toEqual(['pending', 'paid', 'refunding']);

    expect(await webhook({ paymentId: settled.paymentId, status: 'refunded' })).toBe(204);
    expect(await historyOf(settled.id, bob.token)).toEqual(['pending', 'paid', 'refunding', 'refunded']);
  });

  it('keeps the settlements of a member who left for the members who remain, and does not show them to the one who left', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hist-left');
    // Ann records the whole of what Bob owes her in cash: Bob's balance is 0, so he may leave.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 50 },
      token: ann.token,
    });
    const cashId = (cash.body as { id: string }).id;
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBe(204);

    const remaining = await listSettlements(groupId, ann.token);
    expect(remaining.body).toEqual([
      expect.objectContaining({
        id: cashId,
        from: bob.id,
        to: ann.id,
        history: [expect.objectContaining({ status: 'paid' })],
      }),
    ]);
    expect((await listSettlements(groupId, bob.token)).status).toBe(404);
  });

  it('answers an empty list for a group with no settlement, and does not show the group to a stranger or to a caller who is not signed in', async () => {
    const { groupId, ann } = await annAndBobOwing50('hist-empty');
    expect((await listSettlements(groupId, ann.token)).body).toEqual([]);

    const stranger = await signedIn('hist-empty-cy@example.com', 'Cy');
    expect((await listSettlements(groupId, stranger.token)).status).toBe(404);
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`)).status).toBe(401);
  });
});
