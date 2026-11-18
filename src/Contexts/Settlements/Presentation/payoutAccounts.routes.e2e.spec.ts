import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('payout-accounts');

/**
 * The payment provider, as a server of its own: it answers `GET /accounts/{id}` with `200 { id }` for the accounts it knows, `404` for
 * any other, and a failure while the test says it is down (request 16).
 */
let knownAccounts = new Set<string>();
let providerDown = false;
let providerServer: Server;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  providerServer = createServer((request, response) => {
    const match = /^\/accounts\/([^/]+)$/.exec(request.url ?? '');
    if (request.method !== 'GET' || !match) {
      response.writeHead(404).end();
      return;
    }
    if (providerDown) {
      response.writeHead(503).end();
      return;
    }
    const id = decodeURIComponent(match[1]);
    if (!knownAccounts.has(id)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id }));
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  process.env.PROVIDER_URL = providerOrigin;
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
});
beforeEach(() => {
  knownAccounts = new Set<string>();
  providerDown = false;
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

const setPayoutAccount = (accountId: string, token: string) =>
  http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId }, token });

const readPayoutAccount = (token: string) => http.request('GET', `${api}/accounts/me/payout-account`, { token });

describe('a payout account', () => {
  it('is set to an account the provider knows, and read back by its owner', async () => {
    const ann = await signedIn('payout-set-ann@example.com', 'Ann');
    knownAccounts.add('acct-ann-1');

    const set = await setPayoutAccount('acct-ann-1', ann.token);
    expect(set.status).toBe(204);
    const read = await readPayoutAccount(ann.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ accountId: 'acct-ann-1' });
  });

  it('answers 404 to a member who has none, and nobody reads another member’s', async () => {
    const ann = await signedIn('payout-none-ann@example.com', 'Ann');
    const bob = await signedIn('payout-none-bob@example.com', 'Bob');
    knownAccounts.add('acct-ann-2');
    await setPayoutAccount('acct-ann-2', ann.token);

    expect((await readPayoutAccount(bob.token)).status).toBe(404);
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-2' });
  });

  it('replaces the one the member had', async () => {
    const ann = await signedIn('payout-replace-ann@example.com', 'Ann');
    knownAccounts.add('acct-ann-old');
    knownAccounts.add('acct-ann-new');
    await setPayoutAccount('acct-ann-old', ann.token);

    expect((await setPayoutAccount('acct-ann-new', ann.token)).status).toBe(204);
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-new' });
  });

  it('is refused when the provider does not know it, and keeps the one the member had', async () => {
    const ann = await signedIn('payout-unknown-ann@example.com', 'Ann');
    knownAccounts.add('acct-ann-kept');
    await setPayoutAccount('acct-ann-kept', ann.token);

    const refused = await setPayoutAccount('acct-nobody-knows', ann.token);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'UnknownPayoutAccount' });
    expect((await readPayoutAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-kept' });
  });

  it('is refused when the provider does not answer, and nothing is kept', async () => {
    const ann = await signedIn('payout-down-ann@example.com', 'Ann');
    knownAccounts.add('acct-ann-later');
    providerDown = true;

    const refused = await setPayoutAccount('acct-ann-later', ann.token);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'ProviderUnavailable' });
    expect((await readPayoutAccount(ann.token)).status).toBe(404);
  });

  it('is refused to a caller who is not signed in, and to a body with no account', async () => {
    const ann = await signedIn('payout-anonymous-ann@example.com', 'Ann');
    knownAccounts.add('acct-ann-body');
    expect((await setPayoutAccount('acct-ann-body', '')).status).toBe(401);
    expect(
      (await http.request('PUT', `${api}/accounts/me/payout-account`, { body: {}, token: ann.token })).status,
    ).toBe(400);
  });

  it('a cash settlement to a member with no payout account is recorded, as it needs none', async () => {
    const ann = await signedIn('payout-cash-ann@example.com', 'Ann');
    const bob = await signedIn('payout-cash-bob@example.com', 'Bob');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    const settled = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 50 },
      token: ann.token,
    });
    expect(settled.status).toBe(201);
  });
});
