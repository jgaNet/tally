import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 39 over HTTP: a settlement paid in another currency, at the rate the rates service offers when it is decided, kept on it; through the
 * provider, the payment is asked in the currency and the amount paid, and the fee the provider keeps is converted at the same rate.
 */
const SECRET = 'a shared secret for the test';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** The rate the fake rates service offers for each currency to the group's (EUR); a currency not listed has none. */
let offered: Record<string, string> = { CHF: '1.03' };
/** Every question the rates service was asked, as the currency asked for and the day. */
let asked: { currency: string; date: string }[] = [];

/** The fee the fake provider says for the next payment, in the currency it was asked in. */
let nextFee: number | undefined = 2;
/** The payments the fake provider was asked for, in order. */
let received: { reference: string; amount: number; currency: string; payee: string }[] = [];

let rates: Server;
let provider: Server;

const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
const originOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

beforeAll(async () => {
  rates = createServer((request: IncomingMessage, response: ServerResponse) => {
    // `/rates/{from}/{to}?date=`: the rate of `from` in `to`, as the fake offers it.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const [, , currency = ''] = url.pathname.split('/');
    asked = [...asked, { currency, date: url.searchParams.get('date') ?? '' }];
    const rate = offered[currency];
    if (rate === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ currency, rate }));
  });
  await listen(rates);

  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const payment = JSON.parse(body) as { reference: string; amount: number; currency: string; payee: string };
      received = [...received, payment];
      const id = `pay_${received.length}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id,
          payUrl: `https://pay.example/${id}`,
          ...(nextFee !== undefined && { fee: nextFee }),
        }),
      );
    });
  });
  await listen(provider);

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.RATES_URL = originOf(rates);
  process.env.PROVIDER_URL = originOf(provider);
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
  await new Promise(resolve => rates.close(resolve));
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

/** An owner and two members who joined, with a dinner of 60 split between the owner and `grace`: `grace` owes 30. */
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

/** The provider's signed webhook about a payment at the provider. */
const send = (paymentId: string, status: string) => {
  const body = { id: `evt_${paymentId}_${status}`, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const json = JSON.stringify(body);
  const signed = createHmac('sha256', SECRET).update(json).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signed },
  });
};

describe('A settlement in another currency (request 39)', () => {
  it('is paid in cash in another currency at the rate offered that day, and counts its amount in the group currency', async () => {
    offered = { CHF: '1.03' };
    const { ada, grace, groupId } = await groupWhereGraceOwes30();

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, original: { currency: 'CHF', amount: 29 } },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id } = recorded.body as { id: string };

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({
      amount: 30,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 29, rate: '1.03' },
    });
    // The rate is asked for the day the settlement was decided, in UTC: the payer gives none.
    const decidedOn = (read.body as { at: string }).at.slice(0, 10);
    expect(asked).toContainEqual({ currency: 'CHF', date: decidedOn });
    expect((await balancesOf(groupId, ada.token))[grace.id]).toBe(0);
  });

  it('keeps the rate it was decided at, whatever the rates service offers later', async () => {
    offered = { CHF: '1.03' };
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const { id } = (
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, original: { currency: 'CHF', amount: 29 } },
        token: ada.token,
      })
    ).body as { id: string };

    offered = { CHF: '2.00' };
    const read = await http.request('GET', `${api}/settlements/${id}`, { token: ada.token });
    expect(read.body).toMatchObject({ amount: 30, original: { rate: '1.03' } });
    expect((await balancesOf(groupId, ada.token))[grace.id]).toBe(0);
  });

  it('is refused by name, and nothing is kept, when no rate is offered for the currency that day', async () => {
    offered = {};
    const { ada, grace, groupId } = await groupWhereGraceOwes30();

    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, original: { currency: 'CHF', amount: 29 } },
      token: ada.token,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
    const settlements = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ada.token });
    expect(settlements.body).toEqual([]);
    expect((await balancesOf(groupId, ada.token))[grace.id]).toBe(-30);
  });

  it('ignores a rate the payer states, and converts at the offered one', async () => {
    offered = { CHF: '1.03' };
    const { ada, grace, groupId } = await groupWhereGraceOwes30();

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, original: { currency: 'CHF', amount: 29, rate: '9' } },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const read = await http.request('GET', `${api}/settlements/${(recorded.body as { id: string }).id}`, {
      token: ada.token,
    });
    expect(read.body).toMatchObject({ amount: 30, original: { rate: '1.03' } });
  });

  it('is of the wrong shape with neither an amount nor an original payment, or with both', async () => {
    offered = { CHF: '1.03' };
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const post = (body: object) =>
      http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token: ada.token });

    expect((await post({ from: grace.id })).status).toBe(400);
    expect((await post({ from: grace.id, amount: 30, original: { currency: 'CHF', amount: 29 } })).status).toBe(400);
    expect((await post({ from: grace.id, original: { currency: 'CHF' } })).status).toBe(400);
  });

  it('is paid through the provider in the currency and amount paid, and its fee is converted at the same rate', async () => {
    offered = { CHF: '1.03' };
    nextFee = 2;
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const asking = received.length;

    const requested = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, original: { currency: 'CHF', amount: 29 } },
      token: grace.token,
    });
    expect(requested.status).toBe(201);
    const { id } = requested.body as { id: string };

    // The provider is asked for the payment in what is paid: the original amount and its currency.
    expect(received.slice(asking)).toEqual([{ reference: id, amount: 29, currency: 'CHF', payee: `acct_${ada.id}` }]);
    // Until the provider says it succeeded, what is owed still counts it as paid.
    expect((await balancesOf(groupId, grace.token))[grace.id]).toBe(-30);

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({
      amount: 30,
      method: 'provider',
      status: 'pending',
      original: { currency: 'CHF', amount: 29, rate: '1.03' },
      fee: { amount: 2, borneBy: 'payee' },
    });

    const providerPaymentId = `pay_${received.length}`;
    // The webhook is acknowledged with a 2xx (request 13).
    expect(Math.floor((await send(providerPaymentId, 'succeeded')).status / 100)).toBe(2);
    expect((await balancesOf(groupId, grace.token))[grace.id]).toBe(0);
  });

  it('takes the fee the payer bears, converted, off what the payment settles', async () => {
    offered = { CHF: '1.03' };
    nextFee = 9;
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, { body: { borneBy: 'payer' }, token: ada.token });

    const requested = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, original: { currency: 'CHF', amount: 29 } },
      token: grace.token,
    });
    expect(requested.status).toBe(201);
    // The fee of 9 CHF is 9.27, 9 in the group's currency, borne by the payer: 9 is taken off the 30 that settles.
    const read = await http.request('GET', `${api}/settlements/${(requested.body as { id: string }).id}`, {
      token: grace.token,
    });
    expect(read.body).toMatchObject({ amount: 30, fee: { amount: 9, borneBy: 'payer' } });
    nextFee = 2;
  });

  it('asks the provider for nothing when no rate is offered, and keeps nothing', async () => {
    offered = {};
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const asking = received.length;

    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, original: { currency: 'CHF', amount: 29 } },
      token: grace.token,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'NoRateOffered' });
    expect(received.length).toBe(asking);
  });
});
