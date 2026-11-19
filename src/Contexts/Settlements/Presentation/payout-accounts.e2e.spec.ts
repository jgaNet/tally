import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 16 over HTTP: a signed-in person sets the payout account the provider pays them on, which the provider must know; they read
 * their own, and nobody else reads it. A payment through the provider is refused by its name to a payee with none, and when there is one
 * the provider is given that account as the payee; a cash settlement needs none.
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/**
 * A fake provider: `GET /accounts/{id}` answers `200 { id }` for an account it knows (`acct_…`), `404` for `acct_unknown`, and `500` for
 * `acct_broken`; `POST /payments` answers `201 { id, payUrl }` and keeps every payment it got.
 */
let provider: Server;
let received: { reference: string; amount: number; currency: string; payee: string }[] = [];

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        const id = decodeURIComponent(request.url.slice('/accounts/'.length));
        if (id === 'acct_broken') return void response.writeHead(500).end();
        if (!id.startsWith('acct_') || id === 'acct_unknown') return void response.writeHead(404).end();
        response.writeHead(200, { 'content-type': 'application/json' });
        return void response.end(JSON.stringify({ id }));
      }
      const payment = JSON.parse(body) as { reference: string; amount: number; currency: string; payee: string };
      received = [...received, payment];
      const id = `pay_${received.length}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, fee: 0, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = providerOrigin;
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
  return { token, id: (created.body as { id: string }).id };
}

const setAccount = (accountId: string, token?: string) =>
  http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });
const readAccount = (token?: string) => http.request('GET', `${api}/accounts/me/payout-account`, { token });

/** A group of an owner and a member who joined, with an expense of 60 split between them: the member owes 30. */
async function groupWhereGraceOwes30() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
    .body as { id: string };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  return { ada, grace, groupId };
}

describe('Payout accounts (request 16)', () => {
  it('sets the account the provider knows, and reads it back to its owner', async () => {
    const ada = await signedInPerson('Ada');
    expect((await setAccount('acct_ada-1', ada.token)).status).toBe(204);
    const read = await readAccount(ada.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ accountId: 'acct_ada-1' });
  });

  it('replaces the account they had with another the provider knows', async () => {
    const ada = await signedInPerson('Ada');
    await setAccount('acct_ada-1', ada.token);
    expect((await setAccount('acct_ada-2', ada.token)).status).toBe(204);
    expect((await readAccount(ada.token)).body).toEqual({ accountId: 'acct_ada-2' });
  });

  it('refuses an account the provider does not know, by its name, and keeps the one they had', async () => {
    const ada = await signedInPerson('Ada');
    await setAccount('acct_ada-1', ada.token);
    const refused = await setAccount('acct_unknown', ada.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'UnknownPayoutAccount', message: expect.any(String) });
    expect((await readAccount(ada.token)).body).toEqual({ accountId: 'acct_ada-1' });
  });

  it('refuses an account when the provider answers anything else, and does not answer a 5xx', async () => {
    const ada = await signedInPerson('Ada');
    const refused = await setAccount('acct_broken', ada.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'UnknownPayoutAccount', message: expect.any(String) });
  });

  it("answers 404 to a person who has none, 401 to a read or a set with no caller, and lets nobody read another person's", async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    expect((await readAccount(ada.token)).status).toBe(404);
    expect((await readAccount()).status).toBe(401);
    expect((await setAccount('acct_ada-1')).status).toBe(401);
    await setAccount('acct_grace-1', grace.token);
    expect((await readAccount(ada.token)).status).toBe(404);
    expect((await readAccount(grace.token)).body).toEqual({ accountId: 'acct_grace-1' });
  });

  it('refuses a payment through the provider to a payee with no payout account, by its name, and asks the provider nothing', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const before = received.length;
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(asked.status).toBe(400);
    expect(asked.body).toEqual({ type: 'PayeeHasNoPayoutAccount', message: expect.any(String) });
    expect(received.length).toBe(before);
  });

  it('pays a payee through the provider on the account they have at the moment the payment is asked', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    await setAccount('acct_ada-1', ada.token);
    const first = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 10 },
      token: grace.token,
    });
    expect(first.status).toBe(201);
    expect(received.at(-1)).toEqual({
      reference: (first.body as { id: string }).id,
      amount: 10,
      currency: 'EUR',
      payee: 'acct_ada-1',
    });

    await setAccount('acct_ada-2', ada.token);
    const second = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 20 },
      token: grace.token,
    });
    expect(second.status).toBe(201);
    expect(received.at(-1)).toEqual({
      reference: (second.body as { id: string }).id,
      amount: 20,
      currency: 'EUR',
      payee: 'acct_ada-2',
    });
  });

  it('keeps a cash settlement needing no payout account, to a payee with none', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    expect(cash.status).toBe(201);
  });
});
