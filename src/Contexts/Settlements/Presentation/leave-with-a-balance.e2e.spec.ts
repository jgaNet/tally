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
 * Request 20 over HTTP, across Settlements and Groups: a member with a payment through the provider waiting cannot leave the group,
 * and leaves once the provider has said it succeeded; the balance it leaves with passes to the owner in the same step.
 */
const SECRET = 'a shared secret for the leave test';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;

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
      const payment = JSON.parse(body) as { reference: string };
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: `pay_${payment.reference}`, payUrl: `https://pay.example/pay_${payment.reference}` }),
      );
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-leave-with-a-balance-')), 'tally.sqlite');
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  const id = (created.body as { id: string }).id;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { token, id };
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

const balancesOf = async (groupId: string, token: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

/** The provider's signed webhook about a payment, over exactly the bytes it sends. */
const sendWebhook = (paymentId: string, status: string) => {
  const body = { id: `evt_${paymentId}_${status}`, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const json = JSON.stringify(body);
  const signed = createHmac('sha256', SECRET).update(json).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signed },
  });
};

describe('Settlements → Groups', () => {
  it('refuses to archive a group while a payment through the provider is being refunded, found by the group Groups answered (PaymentsWaiting)', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id: settlementId } = asked.body as { id: string };
    const { payUrl } = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token }))
      .body as {
      payUrl: string;
    };
    const paymentId = payUrl.slice(payUrl.lastIndexOf('/') + 1);
    expect((await sendWebhook(paymentId, 'succeeded')).status).toBe(204);
    expect((await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ada.token })).status).toBe(
      204,
    );
    expect((await http.request('GET', `${api}/settlements/${settlementId}`, { token: ada.token })).body).toMatchObject({
      status: 'refunding',
    });

    // The balances still count the refunding payment, so they are 0 and the rule that refuses the archive is the waiting payment's.
    const refused = await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ada.token });
    expect(refused.body).toMatchObject({ type: 'PaymentsWaiting' });
  });

  it('refuses a member while a payment through the provider waits, and lets them leave once it has succeeded, the balances still adding up to 0', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(asked.status).toBe(201);
    const { id: settlementId } = asked.body as { id: string };
    expect(
      (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token })).body,
    ).toMatchObject({ id: settlementId, status: 'pending' });
    const { payUrl } = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token }))
      .body as { payUrl: string };
    const paymentId = payUrl.slice(payUrl.lastIndexOf('/') + 1);

    const refused = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(refused.status).toBe(400);
    expect((refused.body as { type: string }).type).toBe('PaymentWaiting');

    expect((await sendWebhook(paymentId, 'succeeded')).status).toBe(204);
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(left.status).toBe(204);

    const balances = await balancesOf(groupId, ada.token);
    expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);
    expect(balances[ada.id]).toBe(0);
  });
});
