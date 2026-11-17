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
 * Request 13 over HTTP: a payer asks to pay through the provider and gets its link, the payment waits and counts as paid for what is
 * still owed; the provider's signed webhook says it succeeded, or failed, and the balances count it once it is paid. An unsigned or wrongly
 * signed webhook is refused and changes nothing; a provider that gives no link refuses the request and keeps nothing.
 */
const SECRET = 'a shared secret for the test';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** A fake provider: `POST /payments` answers `201 { id, payUrl }`, or refuses while it is `down`; every request it got is kept. */
let provider: Server;
let providerOrigin: string;
let providerDown = false;
let received: { reference: string; amount: number; currency: string }[] = [];

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
      if (providerDown) {
        response.writeHead(500).end();
        return;
      }
      const payment = JSON.parse(body) as { reference: string; amount: number; currency: string };
      received = [...received, payment];
      const id = `pay_${received.length}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-pay-through-provider-')), 'tally.sqlite');
  process.env.PROVIDER_URL = providerOrigin;
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

/** A group of an owner and two members who joined, with the owner's expense of 60 split between the owner and `payer`: `payer` owes 30. */
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

/** The webhook as the provider sends it: its body as JSON, signed with the shared secret over exactly those bytes. */
const webhook = (paymentId: string, status: string, signature?: string) => {
  const body = { id: `evt_${paymentId}_${status}`, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const json = JSON.stringify(body);
  const signed = signature ?? createHmac('sha256', SECRET).update(json).digest('hex');
  return { body, headers: { 'content-type': 'application/json', 'provider-signature': signed }, json };
};
const send = (paymentId: string, status: string, signature?: string) => {
  const { body, headers } = webhook(paymentId, status, signature);
  return http.request('POST', `${api}/provider/webhooks`, { body, headers });
};

describe('Payment through the provider (request 13)', () => {
  it('gives the payer a link, keeps the payment pending and not counted, and counts what is waiting as paid for what is owed', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(asked.status).toBe(201);
    const { id } = asked.body as { id: string };
    expect(received.at(-1)).toEqual({ reference: id, amount: 30, currency: 'EUR', payee: `acct_${ada.id}` });

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: grace.id,
      to: ada.id,
      amount: 30,
      method: 'provider',
      status: 'pending',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      payUrl: expect.stringMatching(/^https:\/\/pay\.example\//),
      history: [{ status: 'pending', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/) }],
    });

    // Not yet counted by the balances, and counted as paid for what is still owed: nothing is left to suggest, and no more can be asked.
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
    const suggested = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, {
      token: linus.token,
    });
    expect(suggested.body).toEqual([]);
    const more = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 1 },
      token: grace.token,
    });
    expect(more.status).toBe(400);
    expect(more.body).toMatchObject({ type: 'SettlementMoreThanOwed' });
  });

  it('refuses a webhook without a signature or with a wrong one with 401, and changes nothing', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id } = asked.body as { id: string };
    const paymentId = `pay_${received.length}`;

    const unsigned = await http.request('POST', `${api}/provider/webhooks`, {
      body: { id: 'evt_u', paymentId, status: 'succeeded', at: '2026-01-02T10:00:00Z' },
    });
    expect(unsigned.status).toBe(401);
    const wrong = await send(paymentId, 'succeeded', 'deadbeef');
    expect(wrong.status).toBe(401);

    expect((await http.request('GET', `${api}/settlements/${id}`, { token: grace.token })).body).toMatchObject({
      status: 'pending',
    });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
  });

  it('counts a payment the provider says succeeded in the balances, once, whatever the webhooks after it say', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id } = asked.body as { id: string };
    const paymentId = `pay_${received.length}`;

    expect((await send(paymentId, 'pending')).status).toBe(204);
    expect((await send(paymentId, 'succeeded')).status).toBe(204);
    expect((await send(paymentId, 'succeeded')).status).toBe(204);
    expect((await send(paymentId, 'failed')).status).toBe(204);

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({ status: 'paid', method: 'provider' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });

  it('never counts a payment the provider says failed, and frees what it held', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const first = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id } = first.body as { id: string };
    expect((await send(`pay_${received.length}`, 'failed')).status).toBe(204);

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({ status: 'failed', method: 'provider' });
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });

    // What it held is freed: the payer may ask for the whole of it again.
    const again = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(again.status).toBe(201);
  });

  it('acknowledges a signed webhook about a payment Tally does not know, and changes nothing', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    expect((await send('pay_nobody_asked_for', 'succeeded')).status).toBe(204);
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
  });

  it('refuses the request with nothing kept when the provider gives no link, and keeps nothing', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    providerDown = true;
    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    providerDown = false;
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'ProviderUnavailable' });

    const saved = process.env.PROVIDER_URL;
    process.env.PROVIDER_URL = '';
    const unconfigured = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    process.env.PROVIDER_URL = saved;
    expect(unconfigured.body).toMatchObject({ type: 'ProviderUnavailable' });

    // Nothing is held: the whole of what is owed can still be asked for.
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
    const allowed = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(allowed.status).toBe(201);
  });

  it('keeps one of two payments asked at once, and refuses the other', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const ask = () =>
      http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
        body: { to: ada.id, amount: 30 },
        token: grace.token,
      });
    const [first, second] = await Promise.all([ask(), ask()]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
  });

  it('answers a payment to no member, by a non-member, or by no one signed in, as the cash settlement does', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const zed = await signedInPerson('Zed');
    const body = { to: ada.id, amount: 1 };
    expect(
      (await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token: grace.token }))
        .status,
    ).toBe(201);
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
          body: { to: 'zed', amount: 1 },
          token: grace.token,
        })
      ).status,
    ).toBe(400);
    expect(
      (await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body, token: zed.token })).status,
    ).toBe(404);
    expect((await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { body })).status).toBe(401);
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
          body: { amount: 1 },
          token: grace.token,
        })
      ).status,
    ).toBe(400);
  });
});
