import { createHmac } from 'node:crypto';
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
 * A group's settlements over HTTP, against a database file and a fake provider on a local port (request 19, fragment 19): the group's
 * settlements, the most recent first, each with every status it has had and when Tally learned it: `paid` for a cash one; `pending`,
 * then `paid` or `failed`, and then `refunding` and `refunded`, for one through the provider. A webhook that changes nothing adds nothing.
 * A member lists them, and still sees those of a member who has left; anyone else does not see the group (`404`), and no one unsigned
 * (`401`).
 */
let directory: string;
let provider: Server;
let paymentsByReference: Map<string, string>;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let webhooks: number;

const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  webhooks = 0;
  directory = mkdtempSync(join(tmpdir(), 'tally-settlement-history-'));
  const databaseUrl = await freshDatabase();

  let nextPayment = 0;
  paymentsByReference = new Map();
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A payout account the provider knows is `acct-…` (request 16).
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
      res.setHeader('content-type', 'application/json');
      if (/^\/payments\/[^/]+\/refunds$/.test(req.url ?? '')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: `refund-${text.length}` }));
        return;
      }
      const body = JSON.parse(text) as { reference: string };
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference, id);
      res.statusCode = 201;
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({ databaseUrl, logger: silent, providerUrl, providerWebhookSecret: SECRET });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  eve = await person('Eve', 'eve@example.com');
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
const payThroughProvider = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token, body });
const settleInCash = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token, body });
const listOf = (token: string, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/settlements`, { token });

/** The provider's signature of a webhook body: HMAC-SHA256 of the body as sent, in lowercase hex. */
const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

/** The provider sends a webhook about a payment, signed. */
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });
};

/** A group of Ann, Bob and Cy in which Ann paid 3000 for all three, split equally: Ann is owed 2000, Bob and Cy each owe 1000. */
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

describe("a group's settlements", () => {
  it('lists them the most recent first, each with every status it has had, earliest first', async () => {
    const groupId = await threeOwing();

    // Cy settles 400 in cash, recorded by Ann: paid, once.
    const cash = await settleInCash(ann.token, groupId, { from: cy.id, amount: 400 });
    expect(cash.status).toBe(201);
    const cashId = (cash.body as { id: string }).id;

    // Bob pays Ann 1000 through the provider: pending, then paid when the provider says so.
    const bobPays = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
    const bobId = (bobPays.body as { id: string }).id;
    expect((await webhook(paymentOf(bobId), 'succeeded')).status).toBe(204);
    // The same verdict again changes nothing, so it adds nothing.
    expect((await webhook(paymentOf(bobId), 'succeeded')).status).toBe(204);

    // Cy pays Ann 600 through the provider, which says it failed: pending, then failed.
    const cyPays = await payThroughProvider(cy.token, groupId, { to: ann.id, amount: 600 });
    const cyId = (cyPays.body as { id: string }).id;
    expect((await webhook(paymentOf(cyId), 'failed')).status).toBe(204);

    // Ann refunds Bob's payment: refunding, then refunded when the provider says so.
    expect((await http.request('POST', `${api}/settlements/${bobId}/refund`, { token: ann.token })).status).toBe(204);
    expect((await webhook(paymentOf(bobId), 'refunded')).status).toBe(204);

    const listed = await listOf(ann.token, groupId);
    expect(listed.status).toBe(200);
    const settlements = listed.body as { id: string; history: { status: string; at: string }[] }[];
    expect(settlements.map(settlement => settlement.id)).toEqual([cyId, bobId, cashId]);

    const [failed, refunded, paid] = settlements;
    expect(failed.history.map(line => line.status)).toEqual(['pending', 'failed']);
    expect(refunded.history.map(line => line.status)).toEqual(['pending', 'paid', 'refunding', 'refunded']);
    expect(paid.history).toEqual([{ status: 'paid', at: expect.any(String) }]);
    for (const settlement of settlements) {
      for (const line of settlement.history) expect(line.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The single settlement reads the same history.
    const read = await http.request('GET', `${api}/settlements/${bobId}`, { token: bob.token });
    expect((read.body as { history: { status: string }[] }).history.map(line => line.status)).toEqual([
      'pending',
      'paid',
      'refunding',
      'refunded',
    ]);
  });

  it('is read by the members, a member who left still reads its settlements, and anyone else does not see the group', async () => {
    const groupId = await threeOwing();
    // Bob pays his 1000 off in cash, so he owes nothing and may leave the group.
    await settleInCash(ann.token, groupId, { from: bob.id, amount: 1000 });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBe(204);

    const byAnn = await listOf(ann.token, groupId);
    expect(byAnn.status).toBe(200);
    expect((byAnn.body as { history: unknown[] }[]).map(s => s.history)).toEqual([
      [{ status: 'paid', at: expect.any(String) }],
    ]);
    expect((await listOf(cy.token, groupId)).status).toBe(200);

    // Bob has left: the group is not his to read any more. Eve was never in it; no one unsigned reads it.
    expect((await listOf(bob.token, groupId)).status).toBe(404);
    expect((await listOf(eve.token, groupId)).status).toBe(404);
    expect((await listOf(undefined as unknown as string, groupId)).status).toBe(401);
  });
});

/** The provider's payment of a settlement Tally asked it for. */
const paymentOf = (settlementId: string) => paymentsByReference.get(settlementId) as string;
