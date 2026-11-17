import { createHmac } from 'crypto';
import { mkdtempSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 15 over HTTP: the payee of a settlement paid through the provider refunds it, whole. The provider is asked to refund the
 * payment; the settlement is `refunding`, and still counted, until the provider's webhook says `refunded`, and then the balances no longer
 * count it. Only the payee may refund, and only a settlement paid through the provider while its payer and payee are still members.
 */
const SECRET = 'a shared secret for the test';

/** A fake provider: payments are created with the next id; refunds are answered with `refundAnswer` and every one it got is kept. */
let provider: Server;
let received: { reference: string; amount: number; currency: string }[] = [];
let refunds: { paymentId: string; reference: string }[] = [];
let refundAnswer = 201;

let server: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

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
      const json = body === '' ? {} : JSON.parse(body);
      if (request.url === '/payments') {
        received = [...received, json as { reference: string; amount: number; currency: string }];
        const id = `pay_${received.length}`;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
        return;
      }
      const match = /^\/payments\/([^/]+)\/refunds$/.exec(request.url ?? '');
      if (match) {
        refunds = [...refunds, { paymentId: decodeURIComponent(match[1]), reference: json.reference }];
        response.writeHead(refundAnswer, { 'content-type': 'application/json' });
        response.end(refundAnswer === 201 ? JSON.stringify({ id: `rf_${refunds.length}` }) : '{}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-refunds-')), 'tally.sqlite');
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
  email: string;
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
  return { id, email, token };
}

/** A group of an owner and two members who joined, with an expense of 60 split between the owner and `grace`: `grace` owes 30. */
async function groupWhereGraceOwes30() {
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
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  return { ada, grace, linus, groupId };
}

/** Asks to pay Ada the 30 Grace owes through the provider; answers the settlement's id and the provider's id for its payment. */
async function askToPay(groupId: string, graceToken: string, adaId: string, amount = 30) {
  const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: adaId, amount },
    token: graceToken,
  });
  expect(asked.status).toBe(201);
  const { id } = asked.body as { id: string };
  expect(received.at(-1)).toMatchObject({ reference: id, amount });
  return { id, paymentId: `pay_${received.length}` };
}

/** A webhook as the provider sends it: the body as JSON, signed with the shared secret over exactly those bytes. */
const sendWebhook = (webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

const refund = (id: string, token: string | undefined) =>
  http.request('POST', `${api}/settlements/${id}/refund`, token === undefined ? {} : { token });

const settlementOf = async (id: string, token: string) =>
  (await http.request('GET', `${api}/settlements/${id}`, { token })).body as { status: string };

const balancesOf = async (groupId: string, token: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

describe('Refund through the payment provider (request 15)', () => {
  it('refunds a paid settlement through the provider, and the balances go back once the provider says it is refunded', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const { id, paymentId } = await askToPay(groupId, grace.token, ada.id);
    expect((await sendWebhook('evt_paid', paymentId, 'succeeded')).status).toBe(204);
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });

    // Only the payee may refund it: the payer, a member, is refused.
    expect((await refund(id, grace.token)).status).toBe(403);
    expect((await refund(id, undefined)).status).toBe(401);
    expect((await refund(id, ada.token)).status).toBe(204);
    expect(refunds.at(-1)).toEqual({ paymentId, reference: id });

    // Refunding, the money has not gone back yet: the settlement and the balances still count it.
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'refunding' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });

    // The provider says it is refunded: the settlement is refunded, and the balances are as they were before it was paid. Said twice, once.
    expect((await sendWebhook('evt_refunded', paymentId, 'refunded')).status).toBe(204);
    expect((await sendWebhook('evt_refunded_again', paymentId, 'refunded')).status).toBe(204);
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'refunded' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });

    // A refunded settlement is not refunded again.
    expect((await refund(id, ada.token)).status).toBe(400);
    expect(refunds).toHaveLength(1);
  });

  it('refuses a settlement in cash, and a refund the provider does not accept, and changes nothing', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();

    // A settlement in cash is not refunded through Tally; it leaves 20 owed, for the payment through the provider below.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 10 },
      token: ada.token,
    });
    expect(cash.status).toBe(201);
    const cashId = (cash.body as { id: string }).id;
    const refusedCash = await refund(cashId, ada.token);
    expect(refusedCash.status).toBe(400);
    expect(refusedCash.body).toMatchObject({ type: 'SettlementNotThroughProvider' });

    const { id, paymentId } = await askToPay(groupId, grace.token, ada.id, 20);
    expect((await sendWebhook('evt_paid', paymentId, 'succeeded')).status).toBe(204);
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });

    refundAnswer = 500;
    const refused = await refund(id, ada.token);
    refundAnswer = 201;
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'ProviderRefundUnavailable' });
    expect(await settlementOf(id, ada.token)).toMatchObject({ status: 'paid' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('refuses a refund once its payer has left the group, and changes nothing', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const { id, paymentId } = await askToPay(groupId, grace.token, ada.id);
    expect((await sendWebhook('evt_paid', paymentId, 'succeeded')).status).toBe(204);

    // Grace leaves with a balance of 0 (request 9); the payment's payer is no longer a member.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(left.status).toBeLessThan(300);

    const asked = refunds.length;
    const refused = await refund(id, ada.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'RefundPartyNotMember' });
    expect(refunds).toHaveLength(asked);
    expect(await settlementOf(id, ada.token)).toMatchObject({ status: 'paid' });
  });

  it('a refunded that overtakes the success of the same payment leaves the settlement refunded, and never counted', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const { id, paymentId } = await askToPay(groupId, grace.token, ada.id);

    expect((await sendWebhook('evt_refunded', paymentId, 'refunded')).status).toBe(204);
    expect((await sendWebhook('evt_succeeded_late', paymentId, 'succeeded')).status).toBe(204);

    expect(await settlementOf(id, ada.token)).toMatchObject({ status: 'refunded' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
  });
});
