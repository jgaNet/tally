import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The history over HTTP, against a database file (request 8, fragment 9): a group's expenses, the latest date first and, on the
 * same date, the most recently recorded first, an edit leaving the order of recording as it was; a member's statement, the
 * earliest date first and, on the same date, the earliest recorded first, with the running balance, which ends at the balance
 * the group's balances give the member; and the 404s for a caller outside the group and for a member who was never one.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-history-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
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

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let carol: Awaited<ReturnType<typeof person>>;
let dana: Awaited<ReturnType<typeof person>>;

const createGroup = async (name = 'Flat') => {
  const { body } = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name, currency: 'EUR' } });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = async (token: string, groupId: string, body: Record<string, unknown>): Promise<string> => {
  const { body: answer } = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  return (answer as { id: string }).id;
};
const expenses = (token: string | undefined, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/expenses`, { token });
const statement = (token: string | undefined, groupId: string, memberId: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const balances = (token: string, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

const DAY_1 = '2020-01-10';
const DAY_2 = '2020-01-12';

describe("a group's expenses", () => {
  it('lists the group’s expenses, the latest date first, then the most recently recorded first; an edit keeps the order of recording', async () => {
    const groupId = await createGroup('Trip');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);

    // Recorded in this order: first (DAY_1), second (DAY_2), third (DAY_1, the most recently recorded of the two DAY_1s).
    const first = await record(ann.token, groupId, {
      description: 'First',
      amount: 3000,
      date: DAY_1,
      splitBetween: [ann.id, bob.id, carol.id],
    });
    const second = await record(bob.token, groupId, {
      description: 'Second',
      amount: 600,
      date: DAY_2,
      splitBetween: [bob.id, carol.id],
    });
    const third = await record(carol.token, groupId, {
      description: 'Third',
      amount: 900,
      date: DAY_1,
      splitBetween: [ann.id, carol.id],
    });

    const before = await expenses(bob.token, groupId);
    expect(before.status).toBe(200);
    expect((before.body as { id: string }[]).map(expense => expense.id)).toEqual([second, third, first]);

    // Editing the first one, from the version its author read, does not move it: it was recorded before the third.
    const edit = await http.request('PUT', `${api}/expenses/${first}`, {
      token: ann.token,
      body: {
        description: 'First, edited',
        amount: 3000,
        date: DAY_1,
        version: 1,
        splitBetween: [ann.id, bob.id, carol.id],
      },
    });
    expect(edit.status).toBe(204);
    const after = await expenses(bob.token, groupId);
    expect((after.body as { id: string; description: string }[]).map(expense => expense.id)).toEqual([
      second,
      third,
      first,
    ]);
    expect((after.body as { description: string }[])[2].description).toBe('First, edited');
  });

  it('lists each expense as GET /expenses/{id} reads it, and leaves out the deleted ones', async () => {
    const groupId = await createGroup('Deleted');
    await joinGroup(groupId, bob);
    const kept = await record(ann.token, groupId, {
      description: 'Kept',
      amount: 400,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });
    const gone = await record(bob.token, groupId, {
      description: 'Gone',
      amount: 200,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });
    await http.request('DELETE', `${api}/expenses/${gone}`, { token: ann.token });

    const listed = await expenses(bob.token, groupId);
    expect(listed.body).toEqual([(await http.request('GET', `${api}/expenses/${kept}`, { token: bob.token })).body]);
  });

  it('answers a group the caller is not in with the same 404 as a group that does not exist, and 401 to no one', async () => {
    const groupId = await createGroup('Only us');
    const stranger = await expenses(dana.token, groupId);
    const missing = await expenses(dana.token, 'no-such-group');
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
    expect((await expenses(undefined, groupId)).status).toBe(401);
  });
});

describe("a member's statement", () => {
  it('lists the expenses the member paid or is in the split of, the earliest date first, with the running balance, and ends at the balance', async () => {
    const groupId = await createGroup('Statement');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);
    // First: DAY_1, paid by Ann, split equally among Ann, Bob and Carol (1000 each).
    await record(ann.token, groupId, {
      description: 'First',
      amount: 3000,
      date: DAY_1,
      splitBetween: [ann.id, bob.id, carol.id],
    });
    // Second: DAY_2, paid by Bob, split between Bob and Carol: Ann is in neither, so she is not in it.
    await record(bob.token, groupId, {
      description: 'Second',
      amount: 600,
      date: DAY_2,
      splitBetween: [bob.id, carol.id],
    });
    // Third: DAY_1, recorded after the first, paid by Carol, split between Ann and Carol (450 each).
    await record(carol.token, groupId, {
      description: 'Third',
      amount: 900,
      date: DAY_1,
      splitBetween: [ann.id, carol.id],
    });

    const annStatement = await statement(ann.token, groupId, ann.id);
    expect(annStatement.status).toBe(200);
    expect(annStatement.body).toEqual({
      memberId: ann.id,
      balance: 1550,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_1,
          description: 'First',
          paid: 3000,
          share: 1000,
          balance: 2000,
        },
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_1,
          description: 'Third',
          paid: 0,
          share: 450,
          balance: 1550,
        },
      ],
    });

    const carolStatement = await statement(bob.token, groupId, carol.id);
    expect(carolStatement.body).toEqual({
      memberId: carol.id,
      balance: -850,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_1,
          description: 'First',
          paid: 0,
          share: 1000,
          balance: -1000,
        },
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_1,
          description: 'Third',
          paid: 900,
          share: 450,
          balance: -550,
        },
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_2,
          description: 'Second',
          paid: 0,
          share: 300,
          balance: -850,
        },
      ],
    });

    // Each member's statement ends at the balance the group's balances give them.
    const grouped = (await balances(ann.token, groupId)).body as { memberId: string; balance: number }[];
    for (const member of [ann, bob, carol]) {
      const { body } = await statement(member.token, groupId, member.id);
      expect((body as { balance: number }).balance).toBe(grouped.find(row => row.memberId === member.id)?.balance);
    }
  });

  it('gives a member with no expenses an empty statement and a balance of 0', async () => {
    const groupId = await createGroup('Quiet');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);
    await record(ann.token, groupId, {
      description: 'Just Ann and Bob',
      amount: 500,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });

    const { body } = await statement(carol.token, groupId, carol.id);
    expect(body).toEqual({ memberId: carol.id, balance: 0, entries: [] });
  });

  it('answers a caller outside the group with the same 404 as a group that does not exist', async () => {
    const groupId = await createGroup('Private');
    const stranger = await statement(dana.token, groupId, ann.id);
    const missing = await statement(dana.token, 'no-such-group', ann.id);
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('answers a statement of someone who was never a member of the group with 404', async () => {
    const groupId = await createGroup('Ours');
    const never = await statement(ann.token, groupId, dana.id);
    expect(never.status).toBe(404);
  });

  it('refuses a caller who is not signed in with 401', async () => {
    const groupId = await createGroup();
    expect((await statement(undefined, groupId, ann.id)).status).toBe(401);
  });

  it('drops a deleted expense from the statement, and the balance follows', async () => {
    const groupId = await createGroup('Deleting');
    await joinGroup(groupId, bob);
    await record(ann.token, groupId, {
      description: 'Kept',
      amount: 1000,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });
    const gone = await record(bob.token, groupId, {
      description: 'Gone',
      amount: 600,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });
    await http.request('DELETE', `${api}/expenses/${gone}`, { token: bob.token });

    const { body } = await statement(bob.token, groupId, bob.id);
    expect(body).toEqual({
      memberId: bob.id,
      balance: -500,
      entries: [
        {
          kind: 'expense',
          expenseId: expect.any(String),
          date: DAY_1,
          description: 'Kept',
          paid: 0,
          share: 500,
          balance: -500,
        },
      ],
    });
  });
});

describe('Groups → Ledger', () => {
  it('finds a group made in Groups by the id its creation answered, and lists and reads its history in Ledger by that same id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Made', currency: 'EUR' },
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };
    await joinGroup(id, bob);

    const recorded = await record(bob.token, id, {
      description: 'Bread',
      amount: 250,
      date: DAY_1,
      splitBetween: [ann.id, bob.id],
    });
    const listed = await expenses(ann.token, id);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: recorded, groupId: id, description: 'Bread' })]);

    const read = await statement(ann.token, id, ann.id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      memberId: ann.id,
      balance: -125,
      entries: [
        { kind: 'expense', expenseId: recorded, date: DAY_1, description: 'Bread', paid: 0, share: 125, balance: -125 },
      ],
    });
  });
});
