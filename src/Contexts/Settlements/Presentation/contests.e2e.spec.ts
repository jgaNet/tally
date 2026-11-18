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
 * A contest of a settlement paid through the provider, over HTTP, against a database and a fake provider on a local port (request 33,
 * fragment 33): the payee contests it and the balances go back to what they were before it was paid, while what is owed still counts it as
 * paid; only the payee, once, and only while it is paid; an administrator (ADMIN_EMAILS, whatever the case) decides it, the contests read oldest
 * first and the log every decision; a webhook about it changes nothing, and a group with one in it cannot be left or archived.
 */
let directory: string;
let provider: Server;
let providerUrl: string;
/** The payments the provider keeps, by the reference Tally gave them (the settlement's id). */
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
  directory = mkdtempSync(join(tmpdir(), 'tally-contests-'));
  const databaseUrl = await freshDatabase();

  nextPayment = 0;
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
      const body = JSON.parse(text || '{}') as { reference?: string };
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference as string, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  // The administrators are given by ADMIN_EMAILS, written in another case than they sign in with (request 33).
  app = await createApplication({
    databaseUrl,
    logger: silent,
    providerUrl,
    providerWebhookSecret: SECRET,
    administratorEmails: ['Admin@Example.com'],
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  eve = await person('Eve', 'eve@example.com');
  admin = await person('Admin', 'admin@example.com');
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
let admin: Awaited<ReturnType<typeof person>>;

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
const contest = (token: string, id: string) => http.request('POST', `${api}/settlements/${id}/contest`, { token });
const decide = (token: string | undefined, id: string, paid: unknown) =>
  http.request('POST', `${api}/admin/settlements/${id}/decision`, { token, body: { paid } });
const read = (token: string, id: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const balances = (groupId: string) => http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
const audit = (groupId: string) => http.request('GET', `${api}/groups/${groupId}/audit`, { token: ann.token });

/** The provider's signature of a webhook body, as the provider makes it: HMAC-SHA256 of the body as sent, in lowercase hex. */
const signatureOf = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

/** The provider sends a webhook about a payment, signed over its body as sent. */
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhooks += 1)}`, paymentId, status, at: WEBHOOK_AT };
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'provider-signature': signatureOf(body) },
  });
};

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
/** The balances before any settlement, and once Bob's 1000 to Ann is counted as paid. */
const atStart = () => balancesOf(2000, -1000, -1000);
const afterBobPaid = () => balancesOf(1000, 0, -1000);

/** A settlement of `payer` to Ann through the provider, which the provider says succeeded: paid and counted by the balances. */
const paidToAnn = async (groupId: string, payer: { token: string }, amount: number) => {
  const { body } = await payThroughProvider(payer.token, groupId, { to: ann.id, amount });
  const id = (body as { id: string }).id;
  expect((await webhook(paymentOf(id), 'succeeded')).status).toBe(204);
  return id;
};

describe('who an administrator is, and who may read the administrators', () => {
  it('is given by the sign-in for the email in ADMIN_EMAILS, whatever its case, and nobody takes it through the API', async () => {
    // Signed in as the administrator, the contests and the log are read.
    expect((await http.request('GET', `${api}/admin/contests`, { token: admin.token })).status).toBe(200);
    expect((await http.request('GET', `${api}/admin/log`, { token: admin.token })).status).toBe(200);

    // Anyone else who is signed in does not see them: they do not exist for them (404); nobody signed in is refused (401).
    expect((await http.request('GET', `${api}/admin/contests`, { token: ann.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/admin/log`, { token: ann.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/admin/contests`)).status).toBe(401);

    // A role in the body of a sign-up is not taken: the account is a user.
    await http.request('POST', `${api}/accounts`, {
      body: { email: 'mallory@example.com', password, name: 'Mallory', role: 'ADMIN' },
    });
    const login = await http.request('POST', `${api}/accounts/login`, {
      body: { email: 'mallory@example.com', password },
    });
    const mallory = (login.body as { token: string }).token;
    expect((await http.request('GET', `${api}/admin/log`, { token: mallory })).status).toBe(404);
  });
});

describe('a contest by the payee', () => {
  it('holds the settlement: the balances are as they were before it was paid, and the history and the audit say so', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, bob, 1000);
    expect((await balances(groupId)).body).toEqual(afterBobPaid());

    const contested = await contest(ann.token, id);
    expect(contested.status).toBe(204);

    expect((await balances(groupId)).body).toEqual(atStart());
    const view = (await read(bob.token, id)).body as { status: string; history: { status: string }[] };
    expect(view.status).toBe('contested');
    expect(view.history.map(line => line.status)).toEqual(['pending', 'paid', 'contested']);
    const entries = (await audit(groupId)).body as { action: string; by: string; amount: number }[];
    expect(entries.filter(entry => entry.action === 'settlement-contested')).toEqual([
      expect.objectContaining({ by: ann.id, amount: 1000 }),
    ]);
  });

  it('is refused for the payer, for another member and for a stranger, and once for a settlement', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, bob, 1000);

    expect((await contest(bob.token, id)).status).toBe(403);
    expect((await contest(cy.token, id)).status).toBe(403);
    expect((await contest(eve.token, id)).status).toBe(404);
    expect((await contest(ann.token, id)).status).toBe(204);
    expect((await contest(ann.token, id)).status).toBe(422);
    expect((await balances(groupId)).body).toEqual(atStart());
  });

  it('is refused for a settlement that is not paid through the provider', async () => {
    const groupId = await threeOwing();
    const { body } = await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 });
    const pending = (body as { id: string }).id;

    expect((await contest(ann.token, pending)).status).toBe(422);
    expect(((await read(ann.token, pending)).body as { status: string }).status).toBe('pending');
  });

  it('leaves the payer and the payee in the group while it is held, and a webhook about it changes nothing', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, bob, 1000);
    expect((await contest(ann.token, id)).status).toBe(204);

    expect(
      (await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ann.token })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await webhook(paymentOf(id), 'failed')).status).toBe(204);
    expect(((await read(ann.token, id)).body as { status: string }).status).toBe('contested');
  });
});

describe("an administrator's decision", () => {
  it('refuses anyone who is not an administrator, and a decision that is not a boolean', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, bob, 1000);
    expect((await contest(ann.token, id)).status).toBe(204);

    expect((await decide(ann.token, id, true)).status).toBe(403);
    expect((await decide(undefined, id, true)).status).toBe(401);
    expect((await decide(admin.token, id, 'yes')).status).toBe(400);
    expect(((await read(ann.token, id)).body as { status: string }).status).toBe('contested');
  });

  it('that the money arrived makes the settlement paid again, counted as before, logged, and decided once', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, bob, 1000);
    expect((await contest(ann.token, id)).status).toBe(204);

    expect((await decide(admin.token, id, true)).status).toBe(204);

    expect((await balances(groupId)).body).toEqual(afterBobPaid());
    const view = (await read(bob.token, id)).body as { status: string; history: { status: string }[] };
    expect(view.status).toBe('paid');
    expect(view.history.map(line => line.status)).toEqual(['pending', 'paid', 'contested', 'paid']);
    const log = (await http.request('GET', `${api}/admin/log`, { token: admin.token })).body as {
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.filter(entry => entry.subjectId === id)).toEqual([
      expect.objectContaining({ by: admin.id, action: 'decided-paid' }),
    ]);
    const entries = (await audit(groupId)).body as { action: string; by: string; subjectId: string }[];
    expect(entries.filter(entry => entry.subjectId === id && entry.action === 'settlement-paid')).toEqual(
      expect.arrayContaining([expect.objectContaining({ by: admin.id })]),
    );
    expect((await decide(admin.token, id, true)).status).toBe(422);
    expect((await decide(admin.token, id, false)).status).toBe(422);
  });

  it('that it was not paid annuls it: what was owed is owed again, and no audit entry is written for it', async () => {
    const groupId = await threeOwing();
    const id = await paidToAnn(groupId, cy, 1000);
    expect((await contest(ann.token, id)).status).toBe(204);

    expect((await decide(admin.token, id, false)).status).toBe(204);

    // Cy's payment was contested, so the balances were back at their start; annulled, they stay there: Cy is owed 1000 again.
    expect((await balances(groupId)).body).toEqual(atStart());
    expect(((await read(bob.token, id)).body as { status: string }).status).toBe('annulled');
    const entries = (await audit(groupId)).body as { action: string; subjectId: string }[];
    expect(entries.filter(entry => entry.subjectId === id).map(entry => entry.action)).toEqual([
      'settlement-paid',
      'settlement-contested',
    ]);
  });

  it('lists the contested settlements now, the earliest contested first, and the log oldest first', async () => {
    const groupId = await threeOwing();
    const first = await paidToAnn(groupId, bob, 1000);
    const second = await paidToAnn(groupId, cy, 1000);
    expect((await contest(ann.token, first)).status).toBe(204);
    expect((await contest(ann.token, second)).status).toBe(204);

    // Other tests' contests are in the same database: only this test's two are placed, by their order.
    const contests = (await http.request('GET', `${api}/admin/contests`, { token: admin.token })).body as {
      id: string;
      status: string;
    }[];
    const ours = contests.map(settlement => settlement.id).filter(id => id === first || id === second);
    expect(ours).toEqual([first, second]);
    expect(contests.every(settlement => settlement.status === 'contested')).toBe(true);

    expect((await decide(admin.token, second, false)).status).toBe(204);
    expect((await decide(admin.token, first, true)).status).toBe(204);
    const log = (await http.request('GET', `${api}/admin/log`, { token: admin.token })).body as {
      subjectId: string;
      action: string;
    }[];
    expect(log.slice(-2).map(entry => [entry.subjectId, entry.action])).toEqual([
      [second, 'decided-annulled'],
      [first, 'decided-paid'],
    ]);
    const left = (await http.request('GET', `${api}/admin/contests`, { token: admin.token })).body as { id: string }[];
    expect(left.map(settlement => settlement.id)).not.toEqual(expect.arrayContaining([first, second]));
  });
});

describe('Groups → Settlements (SettlementMembers)', () => {
  it('a settlement made in the group Groups made is found by the id its creation answered, and contested in that group', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Pair', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    await joinGroup(groupId, bob);
    await record(ann.token, groupId, {
      description: 'Lunch',
      amount: 2000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const id = await paidToAnn(groupId, bob, 1000);

    expect((await contest(ann.token, id)).status).toBe(204);
    const view = (await read(ann.token, id)).body as { groupId: string; status: string };
    expect(view.groupId).toBe(groupId);
    expect(view.status).toBe('contested');
  });
});

describe('Ledger → Settlements (GroupBalances)', () => {
  it('a settlement is decided against the balance of an expense Ledger made, found by the id its recording answered', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    const recorded = await record(ann.token, groupId, {
      description: 'Lunch',
      amount: 2000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    const expenseId = (recorded.body as { id: string }).id;
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).status).toBe(200);

    // Bob owes 1000 of that expense: more is refused, and nothing is kept.
    expect((await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1001 })).status).toBe(422);
    expect((await payThroughProvider(bob.token, groupId, { to: ann.id, amount: 1000 })).status).toBeLessThan(300);
  });
});
