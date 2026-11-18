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
 * Leaving a group over HTTP, against a database file (feature 9, fragment 10, request 20): the owner is refused and a stranger is
 * not there for; a member leaves whatever their balance, which passes to the owner in the same step, so the balances still add up to 0;
 * a member with a payment waiting at the provider is refused until it has ended (Settlements → Groups, WaitingPayments); what concerns
 * them is kept, their statement is still read by the members, and the expenses of a former member can no longer change; joining again
 * makes them the last of the members with 0; and a leave and an expense naming the leaver at the same moment, through two servers on one
 * database, are either counted in what passes or refused.
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

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-leave-'));
  databaseUrl = await freshDatabase();
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
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({
    databaseUrl,
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
  dave = await person('Dave', 'dave@example.com');
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

type Person = Awaited<ReturnType<typeof person>>;
let ann: Person;
let bob: Person;
let carol: Person;
let dave: Person;

const createGroup = async (name: string) => {
  const { body } = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name, currency: 'EUR' } });
  return (body as { id: string }).id;
};

/** Joins a person to the group the way the app asks: the owner invites by a link, the person accepts it. */
const joinGroup = async (groupId: string, who: Person) => {
  const invited = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invited.body as { id: string }).id;
  return http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const recordExpense = async (
  payer: Person,
  groupId: string,
  body: Record<string, unknown> & { description: string; amount: number },
) => {
  const { status, body: answer } = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { date: '2020-01-10', ...body },
  });
  return { status, id: (answer as { id?: string }).id };
};

const expenseVersion = async (expenseId: string) => {
  const { body } = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
  return (body as { version: number }).version;
};

/**
 * A group of Ann (the owner), Bob and Carol, with one expense of 300 that Ann paid for the three of them: Bob and Carol owe 100
 * each, Ann is owed 200.
 */
async function groupWithDinner() {
  const groupId = await createGroup('Trip');
  await joinGroup(groupId, bob);
  await joinGroup(groupId, carol);
  const dinner = await recordExpense(ann, groupId, {
    description: 'Dinner',
    amount: 300,
    splitBetween: [ann.id, bob.id, carol.id],
  });
  return { groupId, dinnerId: dinner.id as string };
}

describe('leaving a group', () => {
  it('refuses the owner with 403 and a stranger with 404, and lets a member leave whatever their balance', async () => {
    const { groupId } = await groupWithDinner();

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: ann.token })).status).toBe(403);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: dave.token })).status).toBe(404);

    // Bob owes 100 for the dinner: he leaves anyway, and the group is no longer his.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeGreaterThanOrEqual(200);
    expect(left.status).toBeLessThan(300);
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).status).toBe(404);
  });

  it('lets a member whose balance is 0 leave: the group is no longer theirs, nor among their groups, nor among the members', async () => {
    const { groupId } = await groupWithDinner();
    // Bob paid 100 for Ann alone: Bob is owed 100, which settles the 100 he owed for the dinner.
    await recordExpense(bob, groupId, {
      description: 'Taxi',
      amount: 100,
      splitExactly: [
        { memberId: ann.id, amount: 100 },
        { memberId: bob.id, amount: 0 },
      ],
    });

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeGreaterThanOrEqual(200);
    expect(left.status).toBeLessThan(300);

    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).status).toBe(404);
    const mine = (await http.request('GET', `${api}/groups/mine`, { token: bob.token })).body as { id: string }[];
    expect(mine.map(group => group.id)).not.toContain(groupId);

    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
    }[];
    expect(members.map(member => member.memberId)).toEqual([ann.id, carol.id]);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.map(row => row.memberId)).toEqual([ann.id, carol.id]);
    expect(balances.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });

  it('keeps what concerns a former member: the statement is still read, and their expenses can no longer change', async () => {
    const { groupId, dinnerId } = await groupWithDinner();
    const taxi = await recordExpense(bob, groupId, {
      description: 'Taxi',
      amount: 100,
      splitExactly: [
        { memberId: ann.id, amount: 100 },
        { memberId: bob.id, amount: 0 },
      ],
    });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(
      300,
    );

    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${bob.id}/statement`, {
      token: ann.token,
    });
    expect(statement.status).toBe(200);
    const read = statement.body as { balance: number; entries: { expenseId: string; share: number }[] };
    expect(read.balance).toBe(0);
    expect(read.entries.map(entry => entry.share)).toEqual([100, 0]);

    // No one can put a former member in a split, nor have them pay one.
    const inSplit = await recordExpense(ann, groupId, {
      description: 'Tea',
      amount: 10,
      splitBetween: [ann.id, bob.id],
    });
    expect(inSplit.status).toBe(422);
    const paid = await recordExpense(bob, groupId, { description: 'Tea', amount: 10, splitBetween: [ann.id, bob.id] });
    expect(paid.status).toBe(404);

    // The expenses that concern them are kept: neither the payer nor the owner may change or delete them.
    const dinnerVersion = await expenseVersion(dinnerId);
    const edit = await http.request('PUT', `${api}/expenses/${dinnerId}`, {
      token: ann.token,
      body: {
        description: 'Dinner',
        amount: 300,
        date: '2020-01-10',
        splitBetween: [ann.id, carol.id],
        version: dinnerVersion,
      },
    });
    expect(edit.status).toBe(422);
    expect((await http.request('DELETE', `${api}/expenses/${dinnerId}`, { token: ann.token })).status).toBe(422);

    const taxiVersion = await expenseVersion(taxi.id as string);
    const taxiEdit = await http.request('PUT', `${api}/expenses/${taxi.id}`, {
      token: ann.token,
      body: {
        description: 'Taxi',
        amount: 100,
        date: '2020-01-10',
        splitExactly: [{ memberId: ann.id, amount: 100 }],
        version: taxiVersion,
      },
    });
    expect(taxiEdit.status).toBe(422);
  });

  it('makes a member who joins again the last of the members, with a balance of 0, and their expenses changeable again', async () => {
    const { groupId, dinnerId } = await groupWithDinner();
    await recordExpense(bob, groupId, {
      description: 'Taxi',
      amount: 100,
      splitExactly: [
        { memberId: ann.id, amount: 100 },
        { memberId: bob.id, amount: 0 },
      ],
    });
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(
      300,
    );

    expect((await joinGroup(groupId, bob)).status).toBeLessThan(300);

    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
    }[];
    expect(members.map(member => member.memberId)).toEqual([ann.id, carol.id, bob.id]);
    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(row => row.memberId === bob.id)?.balance).toBe(0);
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).status).toBe(200);

    const edit = await http.request('PUT', `${api}/expenses/${dinnerId}`, {
      token: ann.token,
      body: {
        description: 'Dinner',
        amount: 300,
        date: '2020-01-10',
        splitBetween: [ann.id, bob.id, carol.id],
        version: await expenseVersion(dinnerId),
      },
    });
    expect(edit.status).toBeLessThan(300);
  });
});

describe('Groups → Ledger (GroupMembers)', () => {
  it('a group made in Groups by the id its creation answered is the one Ledger splits its expenses by, through the API', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    await joinGroup(groupId, carol);

    const expense = await recordExpense(ann, groupId, {
      description: 'Rent',
      amount: 200,
      splitBetween: [ann.id, carol.id],
    });
    expect(expense.status).toBeLessThan(300);

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.map(row => row.memberId)).toEqual([ann.id, carol.id]);
    expect(balances.find(row => row.memberId === carol.id)?.balance).toBe(-100);
  });
});

const balancesOfGroup = async (groupId: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
    memberId: string;
    balance: number;
  }[];

describe('Ledger → Groups (MemberBalances)', () => {
  it('a balance Ledger counts in a group made in Groups is the one Groups asks when a member leaves, found by the same group id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    await joinGroup(groupId, bob);
    const expense = await recordExpense(ann, groupId, {
      description: 'Rent',
      amount: 200,
      splitBetween: [ann.id, bob.id],
    });
    expect(expense.status).toBeLessThan(300);

    // Bob owes 100 of the rent: it passes to Ann, who is owed 100 of it, and she stands at 0.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeLessThan(300);
    const stillFound = await http.request('GET', `${api}/groups/${groupId}`, { token: ann.token });
    expect((stillFound.body as { id: string }).id).toBe(groupId);
    expect(await balancesOfGroup(groupId)).toEqual([{ memberId: ann.id, balance: 0 }]);
  });
});

describe('leaving with a balance (request 20)', () => {
  it('passes what a member owes or is owed to the owner in the same step, and the balances still add up to 0', async () => {
    const { groupId } = await groupWithDinner();
    // Ann is owed 200; Bob and Carol owe 100 each.
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(
      300,
    );
    expect(await balancesOfGroup(groupId)).toEqual([
      { memberId: ann.id, balance: 100 },
      { memberId: carol.id, balance: -100 },
    ]);

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: carol.token })).status).toBeLessThan(
      300,
    );
    expect(await balancesOfGroup(groupId)).toEqual([{ memberId: ann.id, balance: 0 }]);
  });

  it('a member who joins again is the last of the members with a balance of 0, and the owner keeps what passed', async () => {
    const { groupId } = await groupWithDinner();
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBeLessThan(
      300,
    );

    expect((await joinGroup(groupId, bob)).status).toBeLessThan(300);
    expect(await balancesOfGroup(groupId)).toEqual([
      { memberId: ann.id, balance: 100 },
      { memberId: carol.id, balance: -100 },
      { memberId: bob.id, balance: 0 },
    ]);
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('refuses a member with a payment of theirs waiting at the provider, and lets them leave once it has ended', async () => {
    const { groupId } = await groupWithDinner();
    // Bob pays Ann 100 through the provider: it is pending, and is not in the balances until the provider says it succeeded.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(paid.status).toBeLessThan(300);
    const settlementId = (paid.body as { id: string }).id;

    const refused = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(refused.status).toBe(422);
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).status).toBe(200);

    // The provider says the payment succeeded: Bob stands at 0 and leaves.
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
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(left.status).toBeLessThan(300);
  });

  it('a group with a payment of Bob waiting at the provider is archived only once it has ended, by the group id it was made in', async () => {
    const { groupId } = await groupWithDinner();
    // Bob pays Ann 100 through the provider: pending, so not counted. Carol pays Ann her 100 in cash, so only Bob's balance is open.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(paid.status).toBeLessThan(300);
    const settlementId = (paid.body as { id: string }).id;
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: carol.id, to: ann.id, amount: 100 },
    });
    expect(cash.status).toBeLessThan(300);

    expect(await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ann.token })).toMatchObject({
      status: 422,
      body: { type: 'GroupNotSettled' },
    });

    // The provider says the payment succeeded: every balance is 0, and the group is archived.
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
    expect(await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ann.token })).toMatchObject({
      status: 204,
    });
  });
});

describe('leaving at the same moment as an expense (two servers, one database)', () => {
  it('an expense naming the leaver is either counted in what passes or refused, and the members still add up to 0', async () => {
    const { groupId } = await groupWithDinner();
    const other = await createApplication({ databaseUrl, logger: silent, providerUrl, providerWebhookSecret: SECRET });
    await other.start(0);
    const otherHttp = apiClient(other.address);
    try {
      // Carol pays 60 for herself and Bob, while Bob leaves through the first server.
      const [recorded, left] = await Promise.all([
        otherHttp.request('POST', `${api}/groups/${groupId}/expenses`, {
          token: carol.token,
          body: { description: 'Tea', amount: 60, date: '2020-01-10', splitBetween: [carol.id, bob.id] },
        }),
        http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token }),
      ]);
      expect(left.status).toBeLessThan(300);
      // Counted before the leave (2xx), or refused because Bob is no longer a member (422): never a share left with a former member.
      expect(recorded.status === 422 || (recorded.status >= 200 && recorded.status < 300)).toBe(true);

      const balances = await balancesOfGroup(groupId);
      expect(balances.map(row => row.memberId)).toEqual([ann.id, carol.id]);
      expect(balances.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    } finally {
      await other.stop();
    }
  });
});
