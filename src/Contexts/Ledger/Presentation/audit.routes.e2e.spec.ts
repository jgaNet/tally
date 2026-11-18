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
 * The group's audit over HTTP, against a database file (request 28, feature 28, ADR 23): every change of money of a group is an entry
 * of its audit, written with the change, the oldest first, from every context that changed money: an expense recorded, edited and deleted;
 * a cash settlement paid; a provider's payment paid when the provider says so, and refunded; a balance that passed when a member left.
 * A change refused writes no entry; a member reads the audit, and to anyone else the group does not exist.
 */
let directory: string;
let provider: Server;
let providerUrl: string;
/** The provider's payments by the reference Tally gave them (the settlement's id). */
let paymentsByReference: Map<string, string>;
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const SECRET = 'a secret Tally and the provider share';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-audit-'));
  nextPayment = 0;
  paymentsByReference = new Map();
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const id = decodeURIComponent(account[1]);
      res.statusCode = id.startsWith('acct-') ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(id.startsWith('acct-') ? JSON.stringify({ id }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (/\/refunds$/.test(req.url ?? '')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: `refund-${req.url}` }));
        return;
      }
      const body = JSON.parse(text) as { reference: string };
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference, id);
      res.statusCode = 201;
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
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
  carol = await person('Carol', 'carol@example.com');
  dana = await person('Dana', 'dana@example.com');
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it; a payout account at the provider (request 16). */
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
let carol: Awaited<ReturnType<typeof person>>;
let dana: Awaited<ReturnType<typeof person>>;

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

const audit = (token: string | undefined, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/audit`, { token });

const DAY = '2020-01-10';

describe("a group's audit", () => {
  it('writes an entry for each change of money, the oldest first, and none for a change refused or one that changes nothing', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);

    // An expense recorded by Ann, 3000, split between the three of them (request 4).
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 3000, date: DAY, splitBetween: [ann.id, bob.id, carol.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;

    // Bob may not delete Ann's expense: refused, and no entry (request 6).
    expect((await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: bob.token })).status).toBe(403);

    // Ann edits it from version 1 to 6000 (request 6): an entry with the amount after the edit.
    const edited = await http.request('PUT', `${api}/expenses/${expenseId}`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 6000, date: DAY, splitBetween: [ann.id, bob.id, carol.id], version: 1 },
    });
    expect(edited.status).toBe(204);
    // An edit from a version already left behind is refused, and writes nothing (request 6).
    expect(
      (
        await http.request('PUT', `${api}/expenses/${expenseId}`, {
          token: ann.token,
          body: {
            description: 'Dinner',
            amount: 9000,
            date: DAY,
            splitBetween: [ann.id, bob.id, carol.id],
            version: 1,
          },
        })
      ).status,
    ).toBe(409);

    // Ann deletes it: an entry with the amount it had.
    expect((await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: ann.token })).status).toBe(204);

    // Another expense, 3000, Ann paid; Bob owes Ann 1000, and Carol too.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Cinema', amount: 3000, date: DAY, splitBetween: [ann.id, bob.id, carol.id] },
    });

    // Bob pays Ann 1000 in cash, recorded by Ann as the payee (request 12): paid, by Ann.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 1000 },
    });
    expect(cash.status).toBe(201);

    // Carol pays Ann 500 through the provider (request 13): nothing counts until the provider says so.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: carol.token,
      body: { to: ann.id, amount: 500 },
    });
    const settlementId = (paid.body as { id: string }).id;
    expect(
      ((await audit(ann.token, groupId)).body as { action: string; amount: number }[]).some(
        entry => entry.action === 'settlement-paid' && entry.amount === 500,
      ),
    ).toBe(false);

    // The provider says it succeeded: paid, by its payer, Carol.
    const succeeded = await webhook(paymentsByReference.get(settlementId) as string, 'succeeded');
    expect(succeeded.status).toBe(204);

    // Ann refunds it, and the provider says so: refunded, by its payee, Ann (request 15).
    expect((await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ann.token })).status).toBe(
      204,
    );
    expect((await webhook(paymentsByReference.get(settlementId) as string, 'refunded')).status).toBe(204);

    // Carol owes 1000 again and leaves: the balance passes to Ann, by Carol (request 20).
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: carol.token })).status).toBe(204);

    const read = await audit(bob.token, groupId);
    expect(read.status).toBe(200);
    const entries = read.body as {
      id: string;
      at: string;
      by: string;
      action: string;
      subjectId: string;
      amount: number;
    }[];
    // Oldest first: each entry's time is no earlier than the one before.
    expect(entries.every((entry, index) => index === 0 || entries[index - 1].at <= entry.at)).toBe(true);
    expect(entries.map(({ by, action, subjectId, amount }) => ({ by, action, subjectId, amount }))).toEqual([
      { by: ann.id, action: 'expense-recorded', subjectId: expenseId, amount: 3000 },
      { by: ann.id, action: 'expense-edited', subjectId: expenseId, amount: 6000 },
      { by: ann.id, action: 'expense-deleted', subjectId: expenseId, amount: 6000 },
      { by: ann.id, action: 'expense-recorded', subjectId: expect.any(String), amount: 3000 },
      { by: ann.id, action: 'settlement-paid', subjectId: expect.any(String), amount: 1000 },
      { by: carol.id, action: 'settlement-paid', subjectId: settlementId, amount: 500 },
      { by: ann.id, action: 'settlement-refunded', subjectId: settlementId, amount: 500 },
      { by: carol.id, action: 'balance-passed', subjectId: carol.id, amount: -1000 },
    ]);
    // Each entry has exactly the fields the API names, and the group's id is not among them.
    expect(entries.every(entry => Object.keys(entry).sort().join() === 'action,amount,at,by,id,subjectId')).toBe(true);
    // An entry is never changed or removed: the deleted expense's entries stay, and so does the leaver's (request 28).
    expect(entries.filter(entry => entry.subjectId === expenseId)).toHaveLength(3);
  });

  it('answers a caller outside the group, and a member who left, with the same 404 as a group that does not exist, and 401 to no one', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);

    expect((await audit(dana.token, groupId)).status).toBe(404);
    expect((await audit(dana.token, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await audit(undefined, groupId)).status).toBe(401);
    expect((await audit(bob.token, groupId)).status).toBe(200);
  });
});

/** The provider sends a webhook about a payment, signed over its body as sent (request 14). */
let webhookCount = 0;
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh-${(webhookCount += 1)}`, paymentId, status, at: '2026-03-01T10:00:00.000Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, { body, headers: { 'provider-signature': signature } });
};

/*
 * The relationships request 28 carries, over HTTP (ADR 23): each thing is made in its context through the API, the id that request
 * answered is kept, and Ledger's audit finds the entry of that thing by the same id. Each relationship of the context map is named by
 * its title, so that the gate can see the test that holds it.
 */
describe('Settlements → Ledger (SettlementAudit)', () => {
  it('a cash settlement made in Settlements is found in the audit Ledger reads, by the id its recording answered', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    // Ann paid 1000 split between her and Bob: Bob owes Ann 500, so 500 can be settled in cash (request 12).
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Lunch', amount: 1000, date: DAY, splitBetween: [ann.id, bob.id] },
    });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    const settlementId = (recorded.body as { id: string }).id;

    const found = (
      (await audit(bob.token, groupId)).body as { subjectId: string; action: string; by: string; amount: number }[]
    ).find(entry => entry.subjectId === settlementId);
    expect(found).toEqual({
      id: `settlement-paid:${settlementId}`,
      at: expect.any(String),
      by: ann.id,
      action: 'settlement-paid',
      subjectId: settlementId,
      amount: 500,
    });
  });
});

describe('Groups → Ledger (PassedBalances)', () => {
  it('a balance that passed when a member left Groups is found in the audit Ledger reads, by the id the sign-up of that member answered', async () => {
    const groupId = await createGroup();
    const signUp = await http.request('POST', `${api}/accounts`, {
      body: { email: 'eve@example.com', password, name: 'Eve' },
    });
    const eveId = (signUp.body as { id: string }).id;
    const login = await http.request('POST', `${api}/accounts/login`, { body: { email: 'eve@example.com', password } });
    const eveToken = (login.body as { token: string }).token;
    await joinGroup(groupId, { token: eveToken });
    // Ann paid 1000 split between her and Eve: Eve owes 500 when she leaves, and that balance passes to Ann (request 20).
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Taxi', amount: 1000, date: DAY, splitBetween: [ann.id, eveId] },
    });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: eveToken })).status).toBe(204);

    const found = (
      (await audit(ann.token, groupId)).body as { subjectId: string; action: string; by: string; amount: number }[]
    ).find(entry => entry.subjectId === eveId);
    expect(found).toEqual({
      id: `balance-passed:${groupId}:0`,
      at: expect.any(String),
      by: eveId,
      action: 'balance-passed',
      subjectId: eveId,
      amount: -500,
    });
  });
});
