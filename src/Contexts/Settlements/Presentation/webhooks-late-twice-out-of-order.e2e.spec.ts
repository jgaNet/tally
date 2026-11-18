import { jest } from '@jest/globals';
import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';

/**
 * Request 14 over HTTP: the provider's webhooks are not reliable. A webhook that comes twice, under two ids, or late, after Tally was
 * stopped and started again, or to two servers on one database at once, changes a payment once; a status the payment has already had
 * or gone past changes nothing; and every signed webhook is acknowledged with a 2xx.
 */
const SECRET = 'a shared secret for the test';

/** A fake provider: `POST /payments` answers `201 { id, payUrl }` with the next id; every request it got is kept. */
let provider: Server;
let providerOrigin: string;
let received: { reference: string; amount: number; currency: string }[] = [];

/** Tally's servers in this test: each is started in its own module registry, so it opens the database file as a server of its own would. */
const started: FastifyApplication[] = [];

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    // The provider knows every account asked about (request 16): a `GET /accounts/{id}` answers `200 { id }`.
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const payment = JSON.parse(body) as { reference: string; amount: number; currency: string };
      received = [...received, payment];
      const id = `pay_${received.length}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
});

afterAll(async () => {
  await Promise.all(started.map(app => app.stop()));
  await new Promise(resolve => provider.close(resolve));
});

/** Starts a server of Tally on the database file, in a module registry of its own: a server started after another one stopped is a restart. */
async function startTally(): Promise<{ app: FastifyApplication; http: ReturnType<typeof apiClient>; api: string }> {
  let createApplication!: typeof import('@Bootstrap/Fastify/createApplication').createApplication;
  await jest.isolateModulesAsync(async () => {
    ({ createApplication } = await import('@Bootstrap/Fastify/createApplication'));
  });
  const app = await createApplication();
  await app.start(0);
  started.push(app);
  return { app, http: apiClient(app.address), api: `/${app.apiPrefix}` };
}

type Running = Awaited<ReturnType<typeof startTally>>;

let accountCount = 0;
const PASSWORD = 'a long password';

interface Person {
  id: string;
  email: string;
  token: string;
}

async function signedInPerson(server: Running, name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const created = await server.http.request('POST', `${server.api}/accounts`, {
    body: { email, password: PASSWORD, name },
  });
  const token = await tokenOf(server, email);
  const id = (created.body as { id: string }).id;
  await server.http.request('PUT', `${server.api}/accounts/me/payout-account`, {
    body: { accountId: `acct_${id}` },
    token,
  });
  return { token, email, id };
}

/** Signs in an account of the database, as a person does after Tally was started again. */
async function tokenOf(server: Running, email: string): Promise<string> {
  const login = await server.http.request('POST', `${server.api}/accounts/login`, {
    body: { email, password: PASSWORD },
  });
  return (login.body as { token: string }).token;
}

/** A group of an owner and two members who joined, with an expense of 60 split between the owner and `grace`: `grace` owes 30. */
async function groupWhereGraceOwes30(server: Running) {
  const ada = await signedInPerson(server, 'Ada');
  const grace = await signedInPerson(server, 'Grace');
  const linus = await signedInPerson(server, 'Linus');
  const { id: groupId } = (
    await server.http.request('POST', `${server.api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (
      await server.http.request('POST', `${server.api}/groups/${groupId}/invitations`, { token: ada.token })
    ).body as { id: string };
    await server.http.request('POST', `${server.api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  await server.http.request('POST', `${server.api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  return { ada, grace, linus, groupId };
}

/** Asks to pay Ada the 30 Grace owes, and answers the settlement's id and the provider's payment id it was given. */
async function askToPay(server: Running, groupId: string, graceToken: string, adaId: string) {
  const asked = await server.http.request('POST', `${server.api}/groups/${groupId}/settlements/provider`, {
    body: { to: adaId, amount: 30 },
    token: graceToken,
  });
  expect(asked.status).toBe(201);
  const { id } = asked.body as { id: string };
  expect(received.at(-1)).toMatchObject({ reference: id, amount: 30 });
  return { id, paymentId: `pay_${received.length}` };
}

const balancesOf = async (server: Running, groupId: string, token: string) =>
  (
    (await server.http.request('GET', `${server.api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

/** A webhook as the provider sends it: the body as JSON, signed with the shared secret over exactly those bytes. */
const sendWebhook = (server: Running, webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const json = JSON.stringify(body);
  const signature = createHmac('sha256', SECRET).update(json).digest('hex');
  return server.http.request('POST', `${server.api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

describe('Webhooks late, twice or out of order (request 14)', () => {
  it('counts a payment once when the same webhook comes twice, and when two webhooks under two ids say the same', async () => {
    const server = await startTally();
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30(server);
    const { id, paymentId } = await askToPay(server, groupId, grace.token, ada.id);

    expect((await sendWebhook(server, 'evt_1', paymentId, 'succeeded')).status).toBe(204);
    expect((await sendWebhook(server, 'evt_1', paymentId, 'succeeded')).status).toBe(204);
    expect((await sendWebhook(server, 'evt_2', paymentId, 'succeeded')).status).toBe(204);

    expect(
      (await server.http.request('GET', `${server.api}/settlements/${id}`, { token: grace.token })).body,
    ).toMatchObject({ status: 'paid' });
    expect(await balancesOf(server, groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('never moves a payment back: a pending or a failed that comes after a succeeded changes nothing, and is acknowledged', async () => {
    const server = await startTally();
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30(server);
    const { id, paymentId } = await askToPay(server, groupId, grace.token, ada.id);

    expect((await sendWebhook(server, 'evt_s', paymentId, 'succeeded')).status).toBe(204);
    expect((await sendWebhook(server, 'evt_p', paymentId, 'pending')).status).toBe(204);
    expect((await sendWebhook(server, 'evt_f', paymentId, 'failed')).status).toBe(204);

    expect(
      (await server.http.request('GET', `${server.api}/settlements/${id}`, { token: grace.token })).body,
    ).toMatchObject({ status: 'paid' });
    expect(await balancesOf(server, groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('a webhook that comes after Tally was stopped and started again changes what it would have changed on time', async () => {
    const before = await startTally();
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30(before);
    const { id, paymentId } = await askToPay(before, groupId, grace.token, ada.id);
    expect((await sendWebhook(before, 'evt_p', paymentId, 'pending')).status).toBe(204);
    await before.app.stop();

    // Tally is started again on the same database file, and the provider, having had no answer, sends the webhook now.
    const after = await startTally();
    const graceToken = await tokenOf(after, grace.email);
    expect((await sendWebhook(after, 'evt_late', paymentId, 'succeeded')).status).toBe(204);

    expect(
      (await after.http.request('GET', `${after.api}/settlements/${id}`, { token: graceToken })).body,
    ).toMatchObject({
      status: 'paid',
      method: 'provider',
    });
    expect(await balancesOf(after, groupId, graceToken)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('counts a payment once when two servers on one database receive the same webhook at once, and acknowledges both', async () => {
    const first = await startTally();
    const second = await startTally();
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30(first);
    const { id, paymentId } = await askToPay(first, groupId, grace.token, ada.id);

    const answers = await Promise.all([
      sendWebhook(first, 'evt_same', paymentId, 'succeeded'),
      sendWebhook(second, 'evt_same', paymentId, 'succeeded'),
    ]);
    expect(answers.map(answer => answer.status)).toEqual([204, 204]);

    expect(
      (await first.http.request('GET', `${first.api}/settlements/${id}`, { token: grace.token })).body,
    ).toMatchObject({ status: 'paid' });
    expect(await balancesOf(second, groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('acknowledges every signed webhook with a 2xx, whatever its status, and changes nothing for one that changes nothing', async () => {
    const server = await startTally();
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30(server);
    const { paymentId } = await askToPay(server, groupId, grace.token, ada.id);

    for (const status of ['pending', 'processing', 'unknown-status', 'succeeded', 'failed']) {
      expect((await sendWebhook(server, `evt_${status}`, paymentId, status)).status).toBe(204);
    }
    expect((await sendWebhook(server, 'evt_gone', 'pay_nobody_asked_for', 'succeeded')).status).toBe(204);
    // `succeeded` settles the payment; the `failed` after it changes nothing, so the balances stay as the payment left them.
    expect(await balancesOf(server, groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });
});
