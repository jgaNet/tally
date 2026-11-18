import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships request 35 carries, over HTTP (feature 35, ADR 30): a deleted account is in no new split (Ledger asks Groups through
 * GroupMembers), it is paid through the provider and netted with by no one (Settlements asks Groups through SettlementMembers), it stays a
 * member with its balance (Ledger's balances, read by Groups' members list), and a payment through the provider waiting at Settlements keeps
 * its account from being deleted (Settlements → Groups, WaitingPayments). Each relationship of the context map is named by its title, so that the
 * gate can see the test that holds it; each makes the thing through the API, keeps the id that request answered, and reads the other side by it.
 */
let provider: Server;
let providerUrl: string;
/** The provider's payments by the reference Tally gave them (the settlement's id). */
let paymentsByReference: Map<string, string>;
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
/** A day in the past: an expense's day is not after today. */
const PAST_DAY = '2020-01-10';

beforeAll(async () => {
  paymentsByReference = new Map();
  nextPayment = 0;
  // A fake payment provider on a local port: it keeps each payment by its reference, and knows the payout accounts `acct-…`.
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
});
afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

let counter = 0;
/** A signed-in person with a payout account at the provider (request 16): their token and their account id as the account answers it. */
async function person(name: string) {
  const email = `link${++counter}-${name.toLowerCase()}@example.com`;
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  await http.request('PUT', `${api}/accounts/me/payout-account`, { token, body: { accountId: `acct-${counter}` } });
  return { token, id: (me.body as { id: string }).id, name };
}

type Person = Awaited<ReturnType<typeof person>>;

/** A group the owner made, answered with its id, and the others joined it by a link the owner asked for. */
async function groupOf(owner: Person, members: Person[]): Promise<string> {
  const created = await http.request('POST', `${api}/groups`, {
    token: owner.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  for (const member of members) {
    const invited = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invited.body as { id: string }).id}/accept`, {
      token: member.token,
    });
  }
  return groupId;
}

const deleteMe = (who: Person) => http.request('DELETE', `${api}/accounts/me`, { token: who.token });

describe('Groups → Ledger (GroupMembers)', () => {
  it('a deleted member is in no new expense split of the group Groups made by the id it answered, and stays in the balances', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupOf(ann, [bob]);
    expect((await deleteMe(bob)).status).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Taxi', amount: 600, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });

    // Ledger still counts the group by the same id, with Bob in it at his place.
    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
    }[];
    expect(balances.map(row => row.memberId)).toEqual([ann.id, bob.id]);
  });
});

describe('Ledger → Groups (MemberBalances)', () => {
  it('an expense Ledger recorded keeps the balance of a deleted member, which Groups still names by its id', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupOf(ann, [bob]);
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Rent', amount: 200, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;

    expect((await deleteMe(bob)).status).toBe(204);

    // Groups names Bob by the id it answered at his sign-up, as a member who is deleted: the same place, the same role.
    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
      name: string;
      role: string;
    }[];
    expect(members.find(member => member.memberId === bob.id)).toMatchObject({
      name: 'Deleted account',
      role: 'member',
    });
    // Ledger reads the expense it recorded, and Bob's balance as it was.
    const expense = (await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).body as {
      shares: { memberId: string; amount: number }[];
    };
    expect(expense.shares.find(share => share.memberId === bob.id)?.amount).toBe(100);
    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(row => row.memberId === bob.id)?.balance).toBe(-100);
    expect(balances.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });
});

describe('Groups → Settlements (SettlementMembers)', () => {
  it('a deleted account is paid through no provider and netted with by no one, by the id the group answered', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupOf(ann, [bob]);
    expect((await deleteMe(bob)).status).toBe(204);

    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: ann.token,
      body: { to: bob.id, amount: 100 },
    });
    expect(paid).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });

    const netted = await http.request('POST', `${api}/nettings`, {
      token: ann.token,
      body: { with: bob.id, currency: 'EUR' },
    });
    expect(netted).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('refuses the deletion of a member with a payment through the provider waiting, and allows it once the provider has said it succeeded', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await groupOf(ann, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 200, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    // Bob pays Ann 100 through the provider: it is pending, and Groups refuses his deletion by the settlement's id.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(paid.status).toBeLessThan(300);
    const settlementId = (paid.body as { id: string }).id;

    expect(await deleteMe(bob)).toMatchObject({ status: 409, body: { type: 'PaymentWaiting' } });
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).status).toBe(200);

    // The provider says the payment succeeded: nothing waits, and Bob's account is deleted.
    const webhook = {
      id: `wh-${settlementId}`,
      paymentId: paymentsByReference.get(settlementId),
      status: 'succeeded',
      at: WEBHOOK_AT,
    };
    const counted = await http.request('POST', `${api}/provider/webhooks`, {
      body: webhook,
      headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(webhook)).digest('hex') },
    });
    expect(counted.status).toBe(204);
    expect((await deleteMe(bob)).status).toBe(204);
  });
});
