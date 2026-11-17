import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-payments-${randomUUID()}.db`);

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';

/**
 * The payment provider, as a server of its own: it answers `POST /payments` with what the test sets (by default a link), and records
 * each request it was asked. Request 13's suite reads what Tally asked of it, and answers what the test says.
 */
let providerAnswer: { status: number; body?: unknown } | undefined;
let providerRequests: Array<{ reference: string; amount: number; currency: string; payee: string }> = [];
let paymentCount = 0;
let providerServer: Server;
let providerOrigin: string;

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
    if (request.method === 'POST' && request.url === '/payments') {
      providerRequests.push(JSON.parse(text));
      paymentCount += 1;
      const answer = providerAnswer ?? {
        status: 201,
        body: { id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}` },
      };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
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
beforeEach(() => {
  providerAnswer = undefined;
  providerRequests = [];
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

const payThrough = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token });

const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hexadecimal. */
async function webhook(
  payload: { paymentId: string; status: string },
  { signature }: { signature?: string | null } = {},
) {
  const body = JSON.stringify({ id: randomUUID(), at: '2026-11-17T10:00:00Z', ...payload });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = signature === undefined ? createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') : signature;
  if (sig !== null) headers['provider-signature'] = sig;
  const response = await fetch(`${app.address}${api}/provider/webhooks`, { method: 'POST', headers, body });
  return response.status;
}

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

describe('a settlement through the payment provider', () => {
  it('asks the provider for a link, keeps the settlement pending, and counts nothing until its payment succeeds', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('pay-pending');
    const before = await balancesOf(groupId, ann.token);

    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect(providerRequests).toEqual([{ reference: id, amount: 50, currency: 'EUR', payee: `acct-${ann.id}` }]);

    const settlement = await readSettlement(id, bob.token);
    expect(settlement.status).toBe(200);
    expect(settlement.body).toMatchObject({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 50,
      method: 'provider',
      status: 'pending',
      payUrl: `https://pay.example/pay-${paymentCount}`,
    });
    expect(await balancesOf(groupId, ann.token)).toEqual(before);
  });

  it('counts a pending payment as paid for what is still owed: a second one for the same debt is refused', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('pay-still-owed');
    expect((await payThrough(groupId, bob.token, { to: ann.id, amount: 30 })).status).toBe(201);

    // The suggestions count what is waiting as paid: only the 20 still owed is suggested.
    const suggested = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: ann.token });
    expect(suggested.body).toEqual([{ from: bob.id, to: ann.id, amount: 20 }]);

    const second = await payThrough(groupId, bob.token, { to: ann.id, amount: 30 });
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ type: 'SettlementExceedsDebt' });

    const exact = await payThrough(groupId, bob.token, { to: ann.id, amount: 20 });
    expect(exact.status).toBe(201);
  });

  it('keeps nothing and asks for nothing more when the provider gives no link', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('pay-no-link');
    providerAnswer = { status: 500, body: { message: 'down' } };

    const refused = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'ProviderUnavailable' });

    // Nothing was kept: the whole debt is still payable.
    providerAnswer = undefined;
    expect((await payThrough(groupId, bob.token, { to: ann.id, amount: 50 })).status).toBe(201);
  });

  it('is refused when the provider is not configured, and keeps nothing', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('pay-unconfigured');
    const configured = process.env.PROVIDER_URL;
    delete process.env.PROVIDER_URL;
    try {
      const refused = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ type: 'ProviderUnavailable' });
      expect(providerRequests).toEqual([]);
    } finally {
      process.env.PROVIDER_URL = configured;
    }
  });

  it('is refused by its name when the payee has no payout account, and the provider is not asked', async () => {
    const ann = await signedIn('pay-no-account-ann@example.com', 'Ann');
    const bob = await signedIn('pay-no-account-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    const refused = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'PayeeHasNoPayoutAccount' });
    expect(providerRequests).toEqual([]);
  });

  it('is refused to a caller who is not signed in', async () => {
    const { groupId, ann } = await annAndBobOwing50('pay-anonymous');
    const refused = await payThrough(groupId, '', { to: ann.id, amount: 50 });
    expect(refused.status).toBe(401);
  });

  it('refuses a payee who is not a member of the group', async () => {
    const { groupId, bob } = await annAndBobOwing50('pay-outsider');
    const outsider = await signedIn('pay-outsider-cy@example.com', 'Cy');
    const refused = await payThrough(groupId, bob.token, { to: outsider.id, amount: 10 });
    expect(refused.status).toBe(404);
  });
});

describe("the provider's webhook", () => {
  it('refuses a webhook without a signature, or with a wrong one, and changes nothing', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hook-unsigned');
    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;

    expect(await webhook({ paymentId, status: 'succeeded' }, { signature: null })).toBe(401);
    expect(await webhook({ paymentId, status: 'succeeded' }, { signature: 'deadbeef' })).toBe(401);

    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'pending' });
    expect((await balancesOf(groupId, ann.token)).find(each => each.memberId === bob.id)?.balance).toBe(-50);
  });

  it('makes a settlement paid, counted by the balances, when its payment succeeded, once', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hook-succeeded');
    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;

    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
    expect((await balancesOf(groupId, ann.token)).find(each => each.memberId === bob.id)?.balance).toBe(0);

    // A repeated webhook is acknowledged, and changes nothing.
    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'paid' });
  });

  it('makes a settlement failed when its payment failed: never counted, and what it held is free again', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hook-failed');
    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;

    expect(await webhook({ paymentId, status: 'failed' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'failed' });
    expect((await balancesOf(groupId, ann.token)).find(each => each.memberId === bob.id)?.balance).toBe(-50);
    expect((await payThrough(groupId, bob.token, { to: ann.id, amount: 50 })).status).toBe(201);
  });

  it('acknowledges a pending status and a payment it does not know, changing nothing', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('hook-unknown');
    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;

    expect(await webhook({ paymentId, status: 'pending' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ status: 'pending' });
    expect(await webhook({ paymentId: 'pay-never-asked', status: 'succeeded' })).toBe(204);
    expect((await balancesOf(groupId, ann.token)).find(each => each.memberId === bob.id)?.balance).toBe(-50);
  });
});

describe('Groups → Settlements', () => {
  it('makes the group through the API, keeps the id it answered, and settles in it: Groups decides who may, the settlement is found by its own id', async () => {
    const ann = await signedIn('groups-settle-ann@example.com', 'Ann');
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${ann.id}` },
      token: ann.token,
    });
    const bob = await signedIn('groups-settle-bob@example.com', 'Bob');
    const cy = await signedIn('groups-settle-cy@example.com', 'Cy');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    // Cy is not a member of the group Groups made: it is not found there, so it cannot be paid through it.
    expect((await payThrough(groupId, cy.token, { to: ann.id, amount: 10 })).status).toBe(404);

    const paid = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(paid.status).toBe(201);
    const id = (paid.body as { id: string }).id;
    expect((await readSettlement(id, bob.token)).body).toMatchObject({
      id,
      groupId,
      method: 'provider',
      status: 'pending',
    });
  });
});

describe('Ledger → Settlements', () => {
  it('makes the expense through the API, keeps the id it answered, and is settled against the balance it made: the payment is found by its own id', async () => {
    const ann = await signedIn('ledger-settle-ann@example.com', 'Ann');
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${ann.id}` },
      token: ann.token,
    });
    const bob = await signedIn('ledger-settle-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    const expenseId = (expense.body as { id: string }).id;
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).body).toMatchObject({
      id: expenseId,
      groupId,
    });

    // The balance the expense made is what Settlements decides against: Bob owes 50, not 60.
    expect((await payThrough(groupId, bob.token, { to: ann.id, amount: 60 })).status).toBe(422);
    const paid = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(paid.status).toBe(201);
    const id = (paid.body as { id: string }).id;
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, groupId, amount: 50, status: 'pending' });
  });
});

describe('Settlements → Groups, leaving (request 20)', () => {
  it('refuses a member who leaves while a payment of theirs waits at the provider, found by the id it was made with, and lets it leave once the payment succeeded', async () => {
    const { groupId, ann, bob } = await annAndBobOwing50('leave-waits');
    const created = await payThrough(groupId, bob.token, { to: ann.id, amount: 50 });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const paymentId = `pay-${paymentCount}`;

    const refused = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(refused).toMatchObject({ status: 422, body: { type: 'PaymentWaiting' } });
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'pending' });

    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'paid' });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBe(204);
    expect(await balancesOf(groupId, ann.token)).toEqual([{ memberId: ann.id, balance: 0 }]);
  });
});
