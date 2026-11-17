import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Leaving a group over HTTP, against a database file (feature 9, fragment 10): the owner and a member with a balance that is
 * not 0 are refused; a member with a balance of 0 leaves, and the group is no longer theirs; what concerns them is kept, their
 * statement is still read by the members, and the expenses of a former member can no longer change; joining again makes them
 * the last of the members with 0.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-leave-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
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
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
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
  it('refuses the owner with 403, a stranger with 404, and a member whose balance is not 0 with 422', async () => {
    const { groupId } = await groupWithDinner();

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: ann.token })).status).toBe(403);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: dave.token })).status).toBe(404);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).status).toBe(422);

    const stillMember = await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token });
    expect(stillMember.status).toBe(200);
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

    const refused = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect(refused.status).toBe(422);
    const stillFound = await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token });
    expect(stillFound.status).toBe(200);
    expect((stillFound.body as { id: string }).id).toBe(groupId);
  });
});
