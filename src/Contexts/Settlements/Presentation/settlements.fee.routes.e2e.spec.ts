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
 * Who bears the provider's fee, over HTTP (request 38, fragment 38): the owner decides it, a member reads it, and a settlement through the
 * provider asked for from then on keeps the fee the provider said and who bore it, and settles what its payer leaves. The fake provider
 * answers the fee it is given; the balances and the statement count what a settlement settles.
 */
let directory: string;
let provider: Server;
/** The fee the fake provider keeps out of what it pays the payee, in hundredths. */
let providerFee: number;
let paymentsByReference: Map<string, string>;
let nextPayment: number;
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
  directory = mkdtempSync(join(tmpdir(), 'tally-fee-settlements-'));
  const databaseUrl = await freshDatabase();

  nextPayment = 0;
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: providerFee }));
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

beforeEach(() => {
  providerFee = 0;
  paymentsByReference = new Map();
  webhooks = 0;
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

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

const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const payThroughProvider = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/provider`, { token, body });
const read = (token: string, id: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const policyOf = (token: string, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/fee-policy`, { token });
const setPolicy = (token: string, groupId: string, borneBy: string) =>
  http.request('PUT', `${api}/groups/${groupId}/fee-policy`, { token, body: { borneBy } });
const balanceOf = async (groupId: string, memberId: string) => {
  const { body } = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
  return (body as { memberId: string; balance: number }[]).find(row => row.memberId === memberId)?.balance;
};

const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });
};

/** A group of Ann, Bob and Cy in which Ann paid 3000 for all three: Ann is owed 2000, Bob and Cy each owe 1000. */
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

describe('who bears the provider fee, as the owner decides (request 38)', () => {
  it('is the payee until the owner decides; only the owner decides it, and a member reads it', async () => {
    const groupId = await threeOwing();

    expect((await policyOf(bob.token, groupId)).body).toEqual({ borneBy: 'payee' });
    const notOwner = await setPolicy(bob.token, groupId, 'payer');
    expect(notOwner.status).toBe(403);
    expect((await policyOf(bob.token, groupId)).body).toEqual({ borneBy: 'payee' });

    const decided = await setPolicy(ann.token, groupId, 'payer');
    expect(decided.status).toBeLessThan(300);
    expect((await policyOf(cy.token, groupId)).body).toEqual({ borneBy: 'payer' });
  });

  it('refuses a stranger, and a bearer that is none of the three, and changes nothing', async () => {
    const groupId = await threeOwing();

    expect((await policyOf(eve.token, groupId)).status).toBe(404);
    expect((await setPolicy(eve.token, groupId, 'payer')).status).toBe(404);
    const unknown = await setPolicy(ann.token, groupId, 'nobody');
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
    expect((await policyOf(ann.token, groupId)).body).toEqual({ borneBy: 'payee' });
  });

  it('settles what the payer leaves: the payer bears the fee, so the payer still owes it', async () => {
    const groupId = await threeOwing();
    await setPolicy(ann.token, groupId, 'payer');
    providerFee = 31;

    const asked = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 300 });
    expect(asked.status).toBeLessThan(300);
    const settlementId = (asked.body as { id: string }).id;
    const pending = await read(bob.token, settlementId);
    expect(pending.body).toMatchObject({ amount: 300, status: 'pending', fee: { amount: 31, borneBy: 'payer' } });

    await webhook(paymentsByReference.get(settlementId) as string, 'succeeded');
    expect(await balanceOf(groupId, bob.id)).toBe(-(1000 - 269));
    expect(await balanceOf(groupId, ann.id)).toBe(2000 - 269);
  });

  it('shares the fee half and half, the payee bearing the extra hundredth of an odd fee', async () => {
    const groupId = await threeOwing();
    await setPolicy(ann.token, groupId, 'shared');
    providerFee = 31;

    const asked = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 300 });
    const settlementId = (asked.body as { id: string }).id;
    expect((await read(bob.token, settlementId)).body).toMatchObject({ fee: { amount: 31, borneBy: 'shared' } });

    await webhook(paymentsByReference.get(settlementId) as string, 'succeeded');
    expect(await balanceOf(groupId, bob.id)).toBe(-(1000 - 285));
  });

  it('keeps the policy a payment was asked with: a later decision changes no settlement', async () => {
    const groupId = await threeOwing();
    providerFee = 31;

    const asked = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 300 });
    const settlementId = (asked.body as { id: string }).id;
    await setPolicy(ann.token, groupId, 'payer');

    expect((await read(bob.token, settlementId)).body).toMatchObject({ fee: { amount: 31, borneBy: 'payee' } });
  });

  it('refuses a payment whose fee is not less than its amount, and keeps nothing', async () => {
    const groupId = await threeOwing();
    providerFee = 300;

    const refused = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 300 });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'ProviderUnavailable', message: expect.any(String) });
    const kept = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(kept.body).toEqual([]);
  });
});
