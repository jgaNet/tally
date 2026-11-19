import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('provider-fee');

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';

/**
 * The payment provider as a server of its own (request 38): it answers `POST /payments` with the fee the test sets (9 by default), or
 * with what the test sets whole. Its payout accounts are known.
 */
let providerAnswer: { status: number; body?: unknown } | undefined;
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
    if (request.method === 'POST' && request.url === '/payments') {
      paymentCount += 1;
      JSON.parse(text);
      const answer = providerAnswer ?? {
        status: 201,
        body: { id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}`, fee: 9 },
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
beforeEach(() => {
  providerAnswer = undefined;
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** The provider's webhook, signed as the provider signs it (request 13). */
async function webhook(payload: { paymentId: string; status: string }) {
  const body = JSON.stringify({ id: randomUUID(), at: '2026-11-17T10:00:00Z', ...payload });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const response = await fetch(`${app.address}${api}/provider/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
    body,
  });
  return response.status;
}

/**
 * Ann owns a group with Bob, and paid 100 for both: Bob owes Ann 50. Ann has a payout account at the provider, so Bob can pay her
 * through it.
 */
async function annAndBobOwing50(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: ann.token,
  });
  const groupId = (group.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    body: { accountId: `acct-${ann.id}` },
    token: ann.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  return { ann, bob, groupId };
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as Array<{
    memberId: string;
    balance: number;
  }>;

describe('who bears the provider fee (request 38)', () => {
  it('is read by the members, the payee bearing it until the owner decides; another member is refused, and an outsider sees no group', async () => {
    const { bob, groupId } = await annAndBobOwing50('read');
    const outsider = await signedIn('read-outsider@example.com', 'Out');

    const read = await http.request('GET', `${api}/groups/${groupId}/fee-policy`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ borneBy: 'payee' });
    expect((await http.request('GET', `${api}/groups/${groupId}/fee-policy`, { token: outsider.token })).status).toBe(
      404,
    );

    const refused = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: bob.token,
    });
    expect(refused.status).toBe(403);
  });

  it('is decided by the owner, and a settlement asked for keeps the fee and the bearer it was asked with', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('settle');

    const decided = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: ann.token,
    });
    expect(decided.status).toBe(204);

    // Bob pays Ann 30 through the provider, which takes a fee of 9 the payer bears: 21 settles, and Bob still owes the 9.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 30 },
      token: bob.token,
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;
    const asked = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: bob.token })).body as {
      amount: number;
      payUrl: string;
      fee: { amount: number; borneBy: string };
    };
    expect(asked.amount).toBe(30);
    expect(asked.fee).toEqual({ amount: 9, borneBy: 'payer' });

    // The provider's payment is the one the link names: the webhook says it succeeded.
    const paymentId = asked.payUrl.split('/').pop() as string;
    expect(await webhook({ paymentId, status: 'succeeded' })).toBe(204);

    // The payer's balance moves by what settled, 21, not by the 30 asked: Bob owes 29 of the 50.
    const balances = await balancesOf(groupId, ann.token);
    expect(balances.find(each => each.memberId === bob.id)?.balance).toBe(-29);

    // The owner decides again: the settlement keeps the bearer it was asked with.
    await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, { body: { borneBy: 'payee' }, token: ann.token });
    const later = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: bob.token })).body as {
      fee: { borneBy: string };
    };
    expect(later.fee.borneBy).toBe('payer');
  });

  it('keeps nothing when the provider gives no fee, or one that is not less than the payment', async () => {
    const { ann, bob, groupId } = await annAndBobOwing50('refuse');
    providerAnswer = { status: 201, body: { id: 'pay-refused', payUrl: 'https://pay.example/refused' } };
    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 30 },
      token: bob.token,
    });
    expect(refused.status).toBe(422);

    providerAnswer = { status: 201, body: { id: 'pay-big', payUrl: 'https://pay.example/big', fee: 30 } };
    const big = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 30 },
      token: bob.token,
    });
    expect(big.status).toBe(422);

    const balances = await balancesOf(groupId, ann.token);
    expect(balances.find(each => each.memberId === bob.id)?.balance).toBe(-50);
  });
});
