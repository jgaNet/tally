import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A settlement through the payment provider over HTTP, against a database file and a fake provider on a local port (request 13,
 * fragment 13): the link asked with the settlement's id, the amount and the group's currency; the payment waiting and counted as paid
 * for what is still owed; the webhook signed over its body, and a payment counted once the provider says it succeeded; one it says
 * failed never counted and freeing what it held; refusals with nothing kept, when the provider gives no link, or none is configured.
 */
let databaseUrl: string;
let directory: string;
let provider: Server;
let providerUrl: string;
/** How the fake provider answers: a link, a failure, or no answer at all (Tally gives up after 5 seconds). */
let providerMode: 'ok' | 'down' | 'hang';
/** The provider's payments by the reference Tally gave them (the settlement's id): what the provider keeps. */
let paymentsByReference: Map<string, string>;
let providerRequests: { reference: string; amount: number; currency: string }[];
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let webhooks: number;

const SECRET = 'a secret Tally and the provider share';
/** When the provider says it decided a payment, as its webhooks carry it. */
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-provider-settlements-'));
  databaseUrl = await freshDatabase();

  nextPayment = 0;
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A payout account the provider knows is `acct-…` (request 16): `GET /accounts/{id}` answers its id, and nothing else is known.
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const known = decodeURIComponent(account[1]).startsWith('acct-');
      res.statusCode = known ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(known ? JSON.stringify({ id: decodeURIComponent(account[1]) }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text) as { reference: string; amount: number; currency: string };
      providerRequests.push(body);
      if (providerMode === 'hang') return;
      if (providerMode === 'down') {
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({ databaseUrl, logger: silent, providerUrl, providerWebhookSecret: SECRET });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  eve = await person('Eve', 'eve@example.com');
});

beforeEach(() => {
  providerMode = 'ok';
  paymentsByReference = new Map();
  providerRequests = [];
  webhooks = 0;
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  // Every person has a payout account at the provider, so that a payment to them can be asked (request 16).
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token,
    body: { accountId: `acct-${name.toLowerCase()}` },
  });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let cy: Awaited<ReturnType<typeof person>>;
let eve: Awaited<ReturnType<typeof person>>;

const createGroup = async () => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const payThroughProvider = (token: string | undefined, groupId: string, body: unknown, server = http, base = api) =>
  server.request('POST', `${base}/groups/${groupId}/settlements/provider`, { token, body });
const read = (token: string, id: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const balances = (groupId: string) => http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
const suggested = (groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: ann.token });

/** The provider's signature of a webhook body, as the provider makes it: HMAC-SHA256 of the body as sent, in lowercase hex. */
const signatureOf = (body: unknown, secret = SECRET) =>
  createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

/** The provider sends a webhook about a payment: signed by default, with the signature given otherwise. */
const webhook = (paymentId: string, status: string, { signature }: { signature?: string } = {}) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signature ?? signatureOf(body) },
  });
};

/** The provider's payment of a settlement Tally asked it for. */
const paymentOf = (settlementId: string) => paymentsByReference.get(settlementId) as string;

/**
 * A group of Ann, Bob and Cy in which Ann paid 3000 for all three, split equally: Ann is owed 2000, Bob and Cy each owe 1000.
 */
const threeOwing = async () => {
  const groupId = await createGroup();
  await joinGroup(groupId, bob);
  await joinGroup(groupId, cy);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 3000,
    date: PAST_DAY,
    splitBetween: [ann.id, bob.id, cy.id],
  });
  return groupId;
};

/** The balances of the group, in the order the members joined, as the API answers them by their account ids. */
const balancesOf = (annsBalance: number, bobsBalance: number, cysBalance: number) => [
  { memberId: ann.id, balance: annsBalance },
  { memberId: bob.id, balance: bobsBalance },
  { memberId: cy.id, balance: cysBalance },
];
/** Ann is owed 2000, Bob and Cy owe 1000 each, before any payment. */
const atStart = () => balancesOf(2000, -1000, -1000);

describe('a payment through the provider', () => {
  it('asks the provider for a link with the settlement id, the amount and the currency, and keeps it pending, not counted', async () => {
    const groupId = await threeOwing();

    const asked = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;

    expect(providerRequests).toEqual([{ reference: id, amount: 1000, currency: 'EUR', payee: 'acct-ann' }]);

    const read1 = await read(bob.token, id);
    expect(read1.status).toBe(200);
    expect(read1.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 1000,
      method: 'provider',
      status: 'pending',
      at: expect.any(String),
      history: [{ status: 'pending', at: expect.any(String) }],
      payUrl: `https://pay.example/${paymentOf(id)}`,
    });
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('a payment waiting at the provider is counted as paid for what is still owed: a second that would overpay is refused, unasked', async () => {
    const groupId = await threeOwing();
    expect((await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).status).toBe(201);
    expect(providerRequests).toHaveLength(1);

    const overpaying = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1 });
    expect(overpaying.status).toBe(422);
    expect(overpaying.body).toEqual({ type: 'MoreThanPayerOwes', message: expect.any(String) });
    expect(providerRequests).toHaveLength(1);

    // The suggestions count it too: what Bob still owes is 0, so only Cy's transfer is left.
    expect((await suggested(groupId)).body).toEqual([{ from: cy.id, to: ann.id, amount: 1000 }]);
  });

  it('a payment the provider says succeeded is paid and counted by the balances, and a repeated webhook changes nothing', async () => {
    const groupId = await threeOwing();
    const id = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).body as { id: string };

    const acknowledged = await webhook(paymentOf(id.id), 'succeeded');
    expect(acknowledged.status).toBe(204);

    expect(((await read(bob.token, id.id)).body as { status: string }).status).toBe('paid');
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));

    // Sent again, the provider's webhook is acknowledged, and the payment is counted once.
    expect((await webhook(paymentOf(id.id), 'succeeded')).status).toBe(204);
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
  });

  it('a payment the provider says failed is failed, never counted, and frees what it held', async () => {
    const groupId = await threeOwing();
    const first = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).body as { id: string };

    expect((await webhook(paymentOf(first.id), 'failed')).status).toBe(204);

    expect(((await read(bob.token, first.id)).body as { status: string }).status).toBe('failed');
    expect((await balances(groupId)).body).toEqual(atStart());
    expect((await suggested(groupId)).body).toEqual([
      { from: bob.id, to: ann.id, amount: 1000 },
      { from: cy.id, to: ann.id, amount: 1000 },
    ]);

    // What the failed payment held is free again: Bob may ask for the whole of it once more.
    expect((await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).status).toBe(201);
  });

  it('a webhook without a signature, or with one that is not the provider’s, is refused with 401 and changes nothing', async () => {
    const groupId = await threeOwing();
    const id = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).body as { id: string };

    const unsigned = await webhook(paymentOf(id.id), 'succeeded', { signature: '' });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toEqual({ type: 'SignatureNotValid', message: expect.any(String) });

    const wrong = await webhook(paymentOf(id.id), 'succeeded', { signature: 'a'.repeat(64) });
    expect(wrong.status).toBe(401);

    // Signed for another body than the one sent: the signature is over the body as sent, and it is not this one.
    const body = { id: 'wh-forged', paymentId: paymentOf(id.id), status: 'succeeded', at: WEBHOOK_AT };
    const forged = await http.request('POST', `${api}/provider/webhooks`, {
      body: { ...body, status: 'failed' },
      headers: { 'provider-signature': signatureOf(body) },
    });
    expect(forged.status).toBe(401);

    expect(((await read(bob.token, id.id)).body as { status: string }).status).toBe('pending');
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('a pending verdict and a payment Tally does not know are acknowledged, and change nothing', async () => {
    const groupId = await threeOwing();
    const id = (await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).body as { id: string };

    expect((await webhook(paymentOf(id.id), 'pending')).status).toBe(204);
    expect((await webhook('pay-never-made', 'succeeded')).status).toBe(204);

    expect(((await read(bob.token, id.id)).body as { status: string }).status).toBe('pending');
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('is refused, and nothing kept, when the provider gives no link: an answer that is not a 201, or no answer in time', async () => {
    const groupId = await threeOwing();

    providerMode = 'down';
    const down = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
    expect(down.status).toBe(422);
    expect(down.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });

    providerMode = 'hang';
    const silentProvider = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
    expect(silentProvider.status).toBe(422);
    expect(silentProvider.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });

    expect((await balances(groupId)).body).toEqual(atStart());
    expect((await suggested(groupId)).body).toEqual([
      { from: bob.id, to: ann.id, amount: 1000 },
      { from: cy.id, to: ann.id, amount: 1000 },
    ]);
  }, 20000);

  it('is refused, and nothing kept, when no provider is configured', async () => {
    const groupId = await threeOwing();
    const unconfigured = await createApplication({
      databaseUrl,
      logger: silent,
      providerUrl: '',
      providerWebhookSecret: SECRET,
    });
    await unconfigured.start(0);
    try {
      const refused = await payThroughProvider(
        bob.token,
        groupId,
        { to: ann.id, amount: 1000 },
        apiClient(unconfigured.address),
        `/${unconfigured.apiPrefix}`,
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
      expect(providerRequests).toHaveLength(0);
    } finally {
      await unconfigured.stop();
    }
  });

  it('is refused to a payee who is not a member of the group, and to a payer who is not in it, with the same 404', async () => {
    const groupId = await threeOwing();

    const toStranger = await payThroughProvider(bob.token, groupId, { to: eve.id, amount: 1000 });
    expect(toStranger.status).toBe(404);
    const fromStranger = await payThroughProvider(eve.token, groupId, { to: ann.id, amount: 1000 });
    expect(fromStranger.status).toBe(404);
    expect(providerRequests).toHaveLength(0);
  });

  it('two requests decided at once keep one payment and refuse the other unasked, the second decided on the first one', async () => {
    const groupId = await threeOwing();

    // One server, so one connection to the database: the second waits its turn behind the first, which holds it while the provider answers.
    const [first, second] = await Promise.all([
      payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 }),
      payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 422]);
    expect(providerRequests).toHaveLength(1);
    expect((await balances(groupId)).body).toEqual(atStart());
  });
});
