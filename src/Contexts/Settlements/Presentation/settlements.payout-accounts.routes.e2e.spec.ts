import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A member's payout account at the provider, over HTTP, against a database file and a fake provider on a local port (request 16,
 * fragment 16): the account the provider knows is set and read back by its owner only; an account it does not know, or does not
 * confirm (a failure, or no answer within 5 seconds), is refused with nothing set; a payment to a payee without one is refused by name,
 * before the provider is asked, while a cash settlement needs none; and once the payee has one, the payment is asked with it as `payee`.
 */
let directory: string;
let provider: Server;
let providerUrl: string;
/** The payments the provider was asked for: what Tally sent, and how many it answered. */
let paymentRequests: Record<string, unknown>[];
/** The accounts the provider was asked about, by the id Tally gave it. */
let accountRequests: string[];
let payments: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const SECRET = 'a secret Tally and the provider share';
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-payout-accounts-'));
  paymentRequests = [];
  accountRequests = [];
  payments = 0;

  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    // `GET /accounts/{id}`: `acct-…` is known; `broken-…` answers a failure; `slow-…` never answers (Tally gives up after 5 seconds).
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const id = decodeURIComponent(account[1]);
      accountRequests.push(id);
      if (id.startsWith('slow-')) return;
      if (id.startsWith('broken-')) {
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      res.statusCode = id.startsWith('acct-') ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(id.startsWith('acct-') ? JSON.stringify({ id }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      paymentRequests.push(JSON.parse(text) as Record<string, unknown>);
      payments += 1;
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `pay-${payments}`, payUrl: `https://pay.example/pay-${payments}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({
    databaseUrl: await freshDatabase(),
    logger: silent,
    providerUrl,
    providerWebhookSecret: SECRET,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. Nobody has a payout account yet. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let cy: Awaited<ReturnType<typeof person>>;

const setAccount = (token: string | undefined, accountId: unknown) =>
  http.request('PUT', `${api}/accounts/me/payout-account`, { token, body: { accountId } });
const readAccount = (token: string | undefined) => http.request('GET', `${api}/accounts/me/payout-account`, { token });

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

/** A group of Ann, Bob and Cy in which Cy paid 3000 for all three, split equally: Cy is owed 2000, Ann and Bob each owe 1000. */
const threeWithCyOwed = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  await joinGroup(groupId, bob);
  await joinGroup(groupId, cy);
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: cy.token,
    body: { description: 'Dinner', amount: 3000, date: PAST_DAY, splitBetween: [ann.id, bob.id, cy.id] },
  });
  return groupId;
};

describe('a payout account at the provider (request 16)', () => {
  it('is set to the account the provider knows, and read back by its owner', async () => {
    const set = await setAccount(ann.token, 'acct-ann');
    expect(set.status).toBe(204);

    const read = await readAccount(ann.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ accountId: 'acct-ann' });
    expect(accountRequests).toContain('acct-ann');
  });

  it('replaces the one the person had', async () => {
    expect((await setAccount(ann.token, 'acct-ann-2')).status).toBe(204);

    expect((await readAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-2' });
  });

  it('refuses an account the provider does not know, and keeps the one the person had', async () => {
    const refused = await setAccount(ann.token, 'unknown-x');

    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'UnknownPayoutAccount', message: expect.any(String) });
    expect((await readAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-2' });
  });

  it('refuses an account the provider does not confirm: a failure, or no answer within 5 seconds', async () => {
    expect((await setAccount(ann.token, 'broken-x')).body).toEqual({
      type: 'UnknownPayoutAccount',
      message: expect.any(String),
    });
    expect((await setAccount(ann.token, 'slow-x')).status).toBe(422);
    expect((await readAccount(ann.token)).body).toEqual({ accountId: 'acct-ann-2' });
  }, 15_000);

  it('is read by its owner only: a person with none is answered 404', async () => {
    const none = await readAccount(bob.token);

    expect(none.status).toBe(404);
    expect(none.body).toEqual({ type: 'NotFound', message: expect.any(String) });
  });

  it('is refused at once to a caller who is not signed in, and a body without an account id is 400', async () => {
    expect((await setAccount(undefined, 'acct-bob')).status).toBe(401);
    expect((await readAccount(undefined)).status).toBe(401);
    expect(
      (await http.request('PUT', `${api}/accounts/me/payout-account`, { token: bob.token, body: {} })).status,
    ).toBe(400);
  });

  it('a payment to a payee with no payout account is refused by name, unasked; a cash settlement needs none', async () => {
    const groupId = await threeWithCyOwed();
    const asked = paymentRequests.length;

    const refused = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: cy.id, amount: 1000 },
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'PayeeHasNoPayoutAccount', message: expect.any(String) });
    expect(paymentRequests).toHaveLength(asked);

    // Cy, the payee, records the money Bob paid her in cash: no payout account is asked for it.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: cy.token,
      body: { from: bob.id, amount: 1000 },
    });
    expect(cash.status).toBe(201);
  });

  it('once the payee has one, a payment to them is asked with that account as the payee', async () => {
    const groupId = await threeWithCyOwed();
    expect((await setAccount(cy.token, 'acct-cy')).status).toBe(204);

    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: cy.id, amount: 1000 },
    });

    expect(asked.status).toBe(201);
    expect(paymentRequests.at(-1)).toEqual({
      reference: (asked.body as { id: string }).id,
      amount: 1000,
      currency: 'EUR',
      payee: 'acct-cy',
    });
  });
});
