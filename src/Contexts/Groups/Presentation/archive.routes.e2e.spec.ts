import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('archive');

const WEBHOOK_SECRET = 'a-shared-secret-for-the-archiving';

/**
 * The payment provider, as a server of its own: it answers a payment with a link and a refund with an id, and a payout account
 * is known to it. The last payment it made is kept, so the webhook can name it.
 */
let paymentCount = 0;
let lastPaymentId = '';
let providerServer: Server;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => resolve(text));
  });

const answer = (response: ServerResponse, status: number, body?: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    await readBody(request);
    const url = request.url ?? '';
    if (request.method === 'POST' && url === '/payments') {
      paymentCount += 1;
      lastPaymentId = `pay-${paymentCount}`;
      return answer(response, 201, { id: lastPaymentId, payUrl: `https://pay.example/${lastPaymentId}` });
    }
    if (request.method === 'POST' && /^\/payments\/[^/]+\/refunds$/.test(url)) {
      return answer(response, 201, { id: `refund-${randomUUID()}` });
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(url)) {
      return answer(response, 200, { id: decodeURIComponent(url.slice('/accounts/'.length)) });
    }
    return answer(response, 404);
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
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

/** A group made by its owner, answering its id, and the joiner's account joined to it by an invitation. */
async function groupWith(owner: { token: string }, joiner?: { token: string }): Promise<string> {
  const created = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  if (joiner) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const archive = (groupId: string, token: string) => http.request('POST', `${api}/groups/${groupId}/archive`, { token });
const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hexadecimal. */
async function webhook(payload: { paymentId: string; status: string }): Promise<number> {
  const body = JSON.stringify({ id: randomUUID(), at: '2026-11-18T10:00:00Z', ...payload });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const response = await fetch(`${app.address}${api}/provider/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
    body,
  });
  return response.status;
}

describe('Groups → Ledger', () => {
  it('makes a group in Groups, which Ledger finds by the id it answered: its balances, and once archived, no expense in it', async () => {
    const ada = await signedIn('groups-ledger-ada@example.com', 'Ada');
    const groupId = await groupWith(ada);

    const balances = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ada.token });
    expect(balances).toMatchObject({ status: 200, body: [expect.objectContaining({ memberId: ada.id, balance: 0 })] });

    expect((await archive(groupId, ada.token)).status).toBe(204);
    expect(
      await record(groupId, ada.token, {
        description: 'Late',
        amount: 500,
        date: '2026-01-16',
        splitBetween: [ada.id],
      }),
    ).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
  });
});

describe('Ledger → Groups (MemberBalances)', () => {
  it('records an expense in Ledger, which Groups reads to refuse the archiving, and Ledger still finds the expense by its id', async () => {
    const ada = await signedIn('ledger-groups-ada@example.com', 'Ada');
    const bob = await signedIn('ledger-groups-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, bob);
    const created = await record(groupId, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });
    const expenseId = (created.body as { id: string }).id;

    expect(await archive(groupId, ada.token)).toMatchObject({ status: 422, body: { type: 'BalancesNotZero' } });
    expect(await http.request('GET', `${api}/expenses/${expenseId}`, { token: ada.token })).toMatchObject({
      status: 200,
      body: { id: expenseId, groupId },
    });
  });
});

describe('Groups → Settlements', () => {
  it('makes a group in Groups, where a settlement is recorded and read by its id, and once archived, none is recorded', async () => {
    const ada = await signedIn('groups-settlements-ada@example.com', 'Ada');
    const bob = await signedIn('groups-settlements-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, bob);
    await record(groupId, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });

    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 500 },
      token: ada.token,
    });
    const settlementId = (cash.body as { id: string }).id;
    expect(cash.status).toBe(201);
    expect(await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).toMatchObject({
      status: 200,
      body: { id: settlementId, groupId },
    });

    expect((await archive(groupId, ada.token)).status).toBe(204);
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: bob.id, amount: 1 },
        token: ada.token,
      }),
    ).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('has a refund waiting at the provider, which Groups reads to refuse the archiving, and Settlements finds it by its id', async () => {
    const ada = await signedIn('settlements-groups-ada@example.com', 'Ada');
    const bob = await signedIn('settlements-groups-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, bob);
    // Ada is paid through the provider, so she has a payout account at it (request 16).
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${ada.id}` },
      token: ada.token,
    });
    await record(groupId, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });

    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 500 },
      token: bob.token,
    });
    const settlementId = (paid.body as { id: string }).id;
    expect(paid.status).toBe(201);
    expect(await webhook({ paymentId: lastPaymentId, status: 'succeeded' })).toBeLessThan(300);
    expect(await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ada.token })).toMatchObject(
      {
        status: 204,
      },
    );

    // The balances still count a refunding settlement, so they are 0; the payment waiting at the provider refuses the archiving.
    expect(await archive(groupId, ada.token)).toMatchObject({ status: 422, body: { type: 'PaymentsWaiting' } });
    expect(await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).toMatchObject({
      status: 200,
      body: { id: settlementId, status: 'refunding' },
    });
  });
});
