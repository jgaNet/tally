import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 38 over HTTP: the provider says its fee for a payment; the group's owner decides who bears it (the payee until then); a settlement
 * settles what its payer does not bear, and keeps the fee and who bore it as they were when it was asked for.
 */
const SECRET = 'a shared secret for the test';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** The fee the fake provider says for the next payment, or none at all when `undefined`. */
let nextFee: number | undefined = 9;
let provider: Server;
let received: { reference: string; amount: number; currency: string }[] = [];

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
      const payment = JSON.parse(body) as { reference: string; amount: number; currency: string };
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
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
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

/** An owner, and two members who joined, with a dinner of 60 split between the owner and `grace`: `grace` owes 30. */
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

describe('Who bears the provider fee (request 38)', () => {
  it('has the payee bear the fee until the owner decides, and refuses any other member to decide it', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const policy = await http.request('GET', `${api}/groups/${groupId}/fee-policy`, { token: grace.token });
    expect(policy.body).toEqual({ borneBy: 'payee' });

    const refused = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: grace.token,
    });
    expect(refused.status).toBe(403);

    const decided = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'payer' },
      token: ada.token,
    });
    expect(decided.status).toBe(204);
    const read = await http.request('GET', `${api}/groups/${groupId}/fee-policy`, { token: linus.token });
    expect(read.body).toEqual({ borneBy: 'payer' });

    const notAValue = await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, {
      body: { borneBy: 'half' },
      token: ada.token,
    });
    expect(notAValue.status).toBeGreaterThanOrEqual(400);
    expect(notAValue.status).toBeLessThan(500);
  });

  it('refuses a payment through the provider whose fee it did not say, or one not less than the amount, and keeps nothing', async () => {
    const { grace, ada, groupId } = await groupWhereGraceOwes30();
    const before = received.length;
    nextFee = undefined;
    const none = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(none.status).toBeGreaterThanOrEqual(400);
    nextFee = 30;
    const notLess = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(notLess.status).toBeGreaterThanOrEqual(400);
    nextFee = 9;
    expect(received.length).toBe(before + 2);
    expect(await balancesOf(groupId, ada.token)).toEqual(expect.objectContaining({ [grace.id]: -30 }));
  });

  it('keeps the fee and who bore it as the payment was asked for, and settles what the payer does not bear', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    // The payee bears the fee: the first payment settles 30, and the fee it was asked with is kept.
    nextFee = 9;
    const first = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(first.status).toBe(201);
    const firstId = (first.body as { id: string }).id;
    const readFirst = await http.request('GET', `${api}/settlements/${firstId}`, { token: grace.token });
    expect(readFirst.body).toEqual(
      expect.objectContaining({
        amount: 30,
        method: 'provider',
        status: 'pending',
        fee: { amount: 9, borneBy: 'payee' },
      }),
    );
    expect((await send(`pay_${received.length}`, 'failed')).status).toBeLessThan(300);

    // The owner gives the fee to the payer: the next payment settles 21, and the payer still owes the 9.
    await http.request('PUT', `${api}/groups/${groupId}/fee-policy`, { body: { borneBy: 'payer' }, token: ada.token });
    const second = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const secondId = (second.body as { id: string }).id;
    expect((await send(`pay_${received.length}`, 'succeeded')).status).toBeLessThan(300);

    const readSecond = await http.request('GET', `${api}/settlements/${secondId}`, { token: grace.token });
    expect(readSecond.body).toEqual(
      expect.objectContaining({ amount: 30, status: 'paid', fee: { amount: 9, borneBy: 'payer' } }),
    );
    expect(await balancesOf(groupId, ada.token)).toEqual(expect.objectContaining({ [grace.id]: -9 }));

    // The first one keeps the policy it was asked with, though the owner changed it.
    const again = await http.request('GET', `${api}/settlements/${firstId}`, { token: grace.token });
    expect(again.body).toEqual(expect.objectContaining({ fee: { amount: 9, borneBy: 'payee' } }));
  });
});
