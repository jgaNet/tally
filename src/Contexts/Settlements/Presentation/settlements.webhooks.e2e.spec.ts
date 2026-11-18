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
 * The provider's webhooks that are not reliable (request 14): a webhook said twice, or under two ids, counts a payment once; a payment
 * only moves forward, so a verdict it has already had or passed changes nothing; a webhook that arrives after Tally was stopped and
 * started again changes what it would have changed on time; the same webhook at the same moment on two servers over one file is
 * counted once; and every signed webhook is acknowledged with a 2xx, so the provider stops sending it.
 */
let directory: string;
let databaseUrl: string;
let provider: Server;
let providerUrl: string;
/** The provider's payments by the reference Tally gave them (the settlement's id). */
let paymentsByReference: Map<string, string>;
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';
let webhooks: number;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-webhooks-settlements-'));
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
      const body = JSON.parse(text) as { reference: string };
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: 0 }));
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
});

beforeEach(() => {
  paymentsByReference = new Map();
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

const createGroup = async () => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  return (body as { id: string }).id;
};

const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const payThroughProvider = (token: string, groupId: string, body: unknown, server = http, base = api) =>
  server.request('POST', `${base}/groups/${groupId}/settlements/provider`, { token, body });
const read = (token: string, id: string, server = http, base = api) =>
  server.request('GET', `${base}/settlements/${id}`, { token });
const balances = (groupId: string, server = http, base = api) =>
  server.request('GET', `${base}/groups/${groupId}/balances`, { token: ann.token });

const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

/** A webhook body the provider sent: its own id, the payment, what it says, and when. */
const bodyOf = (paymentId: string, status: string, id = `wh-${(webhooks += 1)}`) => ({
  id,
  paymentId,
  status,
  at: WEBHOOK_AT,
});

/** The provider sends a webhook body, signed over that body as sent. */
const send = (body: ReturnType<typeof bodyOf>, server = http, base = api) =>
  server.request('POST', `${base}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });

const paymentOf = (settlementId: string) => paymentsByReference.get(settlementId) as string;

/** A group of Ann, Bob and Cy in which Ann paid 3000 for all three, split equally: Bob and Cy each owe 1000 to Ann. */
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

const balancesOf = (annsBalance: number, bobsBalance: number, cysBalance: number) => [
  { memberId: ann.id, balance: annsBalance },
  { memberId: bob.id, balance: bobsBalance },
  { memberId: cy.id, balance: cysBalance },
];
const atStart = () => balancesOf(2000, -1000, -1000);

/** Bob asks to pay Ann 1000 through the provider: the settlement's id, and the provider's payment of it. */
const bobPaysAnn = async (groupId: string) => {
  const { body } = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
  const id = (body as { id: string }).id;
  return { id, payment: paymentOf(id) };
};

describe('a webhook said twice or under two ids', () => {
  it('the same webhook sent twice, and a second webhook with another id saying the same, count the payment once', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await bobPaysAnn(groupId);

    const once = bodyOf(payment, 'succeeded', 'wh-same');
    expect((await send(once)).status).toBe(204);
    expect((await send(once)).status).toBe(204);
    expect((await send(bodyOf(payment, 'succeeded', 'wh-other-id'))).status).toBe(204);

    expect(((await read(bob.token, id)).body as { status: string }).status).toBe('paid');
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
  });
});

describe('a webhook out of order', () => {
  it('a pending that arrives after the succeeded of the same payment leaves it paid', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await bobPaysAnn(groupId);

    expect((await send(bodyOf(payment, 'succeeded'))).status).toBe(204);
    expect((await send(bodyOf(payment, 'pending'))).status).toBe(204);

    expect(((await read(bob.token, id)).body as { status: string }).status).toBe('paid');
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
  });

  it('a failed that arrives after the succeeded does not undo the payment, and a succeeded after the failed does not revive it', async () => {
    const groupId = await threeOwing();
    const paid = await bobPaysAnn(groupId);
    expect((await send(bodyOf(paid.payment, 'succeeded'))).status).toBe(204);
    expect((await send(bodyOf(paid.payment, 'failed'))).status).toBe(204);
    expect(((await read(bob.token, paid.id)).body as { status: string }).status).toBe('paid');
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));

    // A group of its own: Bob's first payment is paid, so his second in the same group would be refused.
    const otherGroup = await threeOwing();
    const failed = await bobPaysAnn(otherGroup);
    expect((await send(bodyOf(failed.payment, 'failed'))).status).toBe(204);
    expect((await send(bodyOf(failed.payment, 'succeeded'))).status).toBe(204);
    expect(((await read(bob.token, failed.id)).body as { status: string }).status).toBe('failed');
    // The failed payment is never counted, and the first group's balances are unchanged.
    expect((await balances(otherGroup)).body).toEqual(atStart());
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
  });
});

describe('a webhook late, after Tally was stopped and started again', () => {
  it('a webhook sent while Tally was stopped is acknowledged by the next start, and counted then', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await bobPaysAnn(groupId);
    expect(((await read(bob.token, id)).body as { status: string }).status).toBe('pending');

    // Tally is stopped; the provider keeps the webhook until it can deliver it.
    await app.stop();
    app = await createApplication({ databaseUrl, logger: silent, providerUrl, providerWebhookSecret: SECRET });
    await app.start(0);
    http = apiClient(app.address);
    api = `/${app.apiPrefix}`;

    // Delivered after the restart: acknowledged, and what it would have changed on time is changed.
    expect((await send(bodyOf(payment, 'succeeded'))).status).toBe(204);
    expect(((await read(bob.token, id)).body as { status: string }).status).toBe('paid');
    expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
  });
});

describe('a webhook at the same moment on two servers', () => {
  it('the same webhook sent to two servers over one file at once is counted once, and acknowledged by both', async () => {
    const groupId = await threeOwing();
    const { id, payment } = await bobPaysAnn(groupId);

    const other = await createApplication({ databaseUrl, logger: silent, providerUrl, providerWebhookSecret: SECRET });
    await other.start(0);
    try {
      const body = bodyOf(payment, 'succeeded', 'wh-both');
      const [first, second] = await Promise.all([
        send(body, http, api),
        send(body, apiClient(other.address), `/${other.apiPrefix}`),
      ]);
      expect(first.status).toBe(204);
      expect(second.status).toBe(204);

      expect(((await read(bob.token, id)).body as { status: string }).status).toBe('paid');
      expect((await balances(groupId)).body).toEqual(balancesOf(1000, 0, -1000));
    } finally {
      await other.stop();
    }
  });
});
