import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 19 over HTTP: a member lists the group's settlements, in cash and through the provider, the most recently recorded first, each
 * with every status it has had, the earliest first. A webhook that changes nothing adds nothing. The members still see the settlements of
 * a member who has left; anyone else gets the answer for a group that does not exist.
 */
const SECRET = 'a shared secret for the test';

/** A fake provider: payments are created with the next id; refunds are accepted. */
let provider: Server;
let received: { reference: string; amount: number; currency: string }[] = [];

let server: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const json = body === '' ? {} : JSON.parse(body);
      if (request.url === '/payments') {
        received = [...received, json as { reference: string; amount: number; currency: string }];
        const id = `pay_${received.length}`;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
        return;
      }
      if (/^\/payments\/([^/]+)\/refunds$/.test(request.url ?? '')) {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'rf_1' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  server = await createApplication();
  await server.start(0);
  http = apiClient(server.address);
  api = `/${server.apiPrefix}`;
});

afterAll(async () => {
  await server.stop();
  await new Promise(resolve => provider.close(resolve));
});

let accountCount = 0;
const PASSWORD = 'a long password';

interface Person {
  id: string;
  token: string;
}

async function signedInPerson(name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  const id = (created.body as { id: string }).id;
  const token = (login.body as { token: string }).token;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { id, token };
}

/** A group of an owner, Ada, and two members who joined, Grace and Linus. */
async function groupOfThree() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return { ada, grace, linus, groupId };
}

/** Ada pays `amount` for a dinner split between her and `other`, so `other` owes half of it. */
const dinnerWith = (groupId: string, ada: Person, other: Person, amount: number) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount, date: '2020-01-15', splitBetween: [ada.id, other.id] },
    token: ada.token,
  });

/** A webhook as the provider sends it: the body as JSON, signed with the shared secret over exactly those bytes. */
const sendWebhook = (webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

/** Asks `payer` to pay `to` through the provider; answers the settlement's id and the provider's id for its payment. */
async function askToPay(groupId: string, payer: Person, to: Person, amount: number) {
  const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: to.id, amount },
    token: payer.token,
  });
  expect(asked.status).toBe(201);
  const { id } = asked.body as { id: string };
  expect(received.at(-1)).toMatchObject({ reference: id, amount });
  return { id, paymentId: `pay_${received.length}` };
}

type Listed = { id: string; from: string; to: string; status: string; history: { status: string; at: string }[] };
const listOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/settlements`, { token })).body as Listed[];

describe('A group’s settlements (request 19)', () => {
  it('lists them, the most recent first, each with every status it has had, the earliest first', async () => {
    const { ada, grace, linus, groupId } = await groupOfThree();
    await dinnerWith(groupId, ada, grace, 60); // Grace owes 30

    // In cash: recorded paid, and that is its only status.
    const cash = (
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, amount: 30 },
        token: ada.token,
      })
    ).body as { id: string };

    // Through the provider, and failed: pending, then failed. Grace owes 20 more.
    await dinnerWith(groupId, ada, grace, 40);
    const failed = await askToPay(groupId, grace, ada, 20);
    expect((await sendWebhook('wh_1', failed.paymentId, 'failed')).status).toBe(204);

    // Through the provider, paid, then refunded: pending, paid, refunding, refunded. Linus owes 30.
    await dinnerWith(groupId, ada, linus, 60);
    const paid = await askToPay(groupId, linus, ada, 30);
    expect((await sendWebhook('wh_2', paid.paymentId, 'succeeded')).status).toBe(204);
    // Webhooks that change nothing add nothing: a repeat of the outcome, and a status still pending.
    await sendWebhook('wh_3', paid.paymentId, 'succeeded');
    await sendWebhook('wh_4', paid.paymentId, 'pending');
    expect((await http.request('GET', `${api}/settlements/${paid.id}`, { token: ada.token })).body).toMatchObject({
      status: 'paid',
      history: [{ status: 'pending' }, { status: 'paid' }],
    });
    expect((await http.request('POST', `${api}/settlements/${paid.id}/refund`, { token: ada.token })).status).toBe(204);
    expect((await sendWebhook('wh_5', paid.paymentId, 'refunded')).status).toBe(204);

    const listed = await listOf(groupId, ada.token);
    expect(listed.map(settlement => settlement.id)).toEqual([paid.id, failed.id, cash.id]);
    expect(listed.map(settlement => settlement.history.map(line => line.status))).toEqual([
      ['pending', 'paid', 'refunding', 'refunded'],
      ['pending', 'failed'],
      ['paid'],
    ]);
    expect(listed[0]).toMatchObject({ from: linus.id, to: ada.id, status: 'refunded' });
    // Each line says when Tally learned the status, and they are the earliest first.
    for (const settlement of listed) {
      const times = settlement.history.map(line => Date.parse(line.at));
      expect(times).toEqual([...times].sort((earlier, later) => earlier - later));
    }
    // The same history is read on the settlement itself (request 19).
    expect((await http.request('GET', `${api}/settlements/${cash.id}`, { token: grace.token })).body).toMatchObject({
      history: [{ status: 'paid' }],
    });
  });

  it('still shows the settlements of a member who has left, and a group does not exist for anyone else', async () => {
    const { ada, grace, linus, groupId } = await groupOfThree();
    const zed = await signedInPerson('Zed');
    await dinnerWith(groupId, ada, grace, 60);
    const cash = (
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, amount: 30 },
        token: ada.token,
      })
    ).body as { id: string };

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(left.status).toBeGreaterThanOrEqual(200);
    expect(left.status).toBeLessThan(300);

    for (const member of [ada, linus]) {
      expect(await listOf(groupId, member.token)).toEqual([
        expect.objectContaining({
          id: cash.id,
          from: grace.id,
          history: [expect.objectContaining({ status: 'paid' })],
        }),
      ]);
    }
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: grace.token })).status).toBe(
      404,
    );
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: zed.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`, {})).status).toBe(401);
  });
});
