import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Archiving a group over HTTP, against a database file (feature 27, fragment 27, request 27): the owner archives it once every balance
 * is 0; a member who is not the owner is refused and a stranger is not there for; an archived group reads as before, with `archivedAt`
 * and only then; and every change in it (an expense, a budget, an invitation, joining, leaving, a cash settlement, an expense's deletion,
 * archiving it again) is refused by the one rule's name, GroupArchived, and changes nothing.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
/** A day in the past: the rule is about today, not the machine's clock. */
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-archive-'));
  const started = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
  await started.start(0);
  app = started;
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  carol = await person('Carol', 'carol@example.com');
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
  return { token, id: (me.body as { id: string }).id };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let carol: Awaited<ReturnType<typeof person>>;

/** A new group of Ann's, so each test starts from a group no other test has touched. */
const newGroup = async (): Promise<string> => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  return (body as { id: string }).id;
};
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};
const archive = (token: string, groupId: string) => http.request('POST', `${api}/groups/${groupId}/archive`, { token });
const read = (token: string, groupId: string) => http.request('GET', `${api}/groups/${groupId}`, { token });
const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });

describe('archiving a group', () => {
  it('is done by the owner once every balance is 0, and then the group reads archivedAt, and only then', async () => {
    const groupId = await newGroup();
    expect((await read(ann.token, groupId)).body).not.toHaveProperty('archivedAt');

    expect(await archive(ann.token, groupId)).toMatchObject({ status: 204 });

    expect(await read(ann.token, groupId)).toMatchObject({
      status: 200,
      body: { id: groupId, archivedAt: expect.any(String) },
    });
    const mine = (await http.request('GET', `${api}/groups/mine`, { token: ann.token })).body as {
      id: string;
      archivedAt?: string;
    }[];
    expect(mine.find(group => group.id === groupId)).toHaveProperty('archivedAt');
  });

  it('is refused while a balance is not 0, to any member who is not the owner, and to someone outside the group', async () => {
    const groupId = await newGroup();
    await joinGroup(groupId, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 3000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    expect(await archive(ann.token, groupId)).toMatchObject({
      status: 422,
      body: { type: 'GroupNotSettled' },
    });
    expect(await archive(bob.token, groupId)).toMatchObject({ status: 403 });
    expect(await archive(carol.token, groupId)).toMatchObject({ status: 404 });
    expect(await read(ann.token, groupId)).not.toHaveProperty('body.archivedAt');
  });

  it('refuses every change in an archived group by the name of its rule, changes nothing, and still reads everything', async () => {
    const groupId = await newGroup();
    await joinGroup(groupId, bob);
    // Ann pays for herself alone: every balance is 0, so the group may be archived.
    const dinner = await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const expenseId = (dinner.body as { id: string }).id;
    // An invitation made before the archive, to be used after it.
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitationId = (invitation.body as { id: string }).id;

    expect(await archive(ann.token, groupId)).toMatchObject({ status: 204 });

    const refused = { status: 422, body: { type: 'GroupArchived' } };
    expect(
      await record(ann.token, groupId, { description: 'Taxi', amount: 500, date: PAST_DAY, splitBetween: [ann.id] }),
    ).toMatchObject(refused);
    expect(await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: ann.token })).toMatchObject(refused);
    expect(
      await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
        token: ann.token,
        body: { amount: 10000 },
      }),
    ).toMatchObject(refused);
    expect(await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token })).toMatchObject(
      refused,
    );
    expect(
      await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: carol.token }),
    ).toMatchObject(refused);
    expect(await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token })).toMatchObject(refused);
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        token: ann.token,
        body: { from: bob.id, to: ann.id, amount: 100 },
      }),
    ).toMatchObject(refused);
    expect(await archive(ann.token, groupId)).toMatchObject(refused);

    // Nothing changed: Carol did not join, Bob is still a member, and the one expense is still there.
    expect(await read(carol.token, groupId)).toMatchObject({ status: 404 });
    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
    }[];
    expect(members.map(member => member.memberId)).toEqual([ann.id, bob.id]);
    expect(await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).toMatchObject({
      status: 200,
    });

    // Reads go on as before for the members.
    expect(await http.request('GET', `${api}/groups/${groupId}/balances`, { token: bob.token })).toMatchObject({
      status: 200,
    });
    expect(await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: bob.token })).toMatchObject({
      status: 200,
    });
    expect(await read(bob.token, groupId)).toMatchObject({ status: 200, body: { archivedAt: expect.any(String) } });
  });
});

describe('Groups → Ledger (GroupMembers)', () => {
  it('a group archived in Groups by the id its creation answered is refused an expense by Ledger, and Ledger reads its balances by that same id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Trip', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    expect(await archive(ann.token, groupId)).toMatchObject({ status: 204 });

    expect(
      await record(ann.token, groupId, { description: 'Taxi', amount: 500, date: PAST_DAY, splitBetween: [ann.id] }),
    ).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).toMatchObject({
      status: 200,
      body: [{ memberId: ann.id, balance: 0 }],
    });
  });
});

describe('Groups → Settlements (SettlementMembers)', () => {
  it('a group archived in Groups by the id its creation answered is refused a cash settlement by Settlements, and its history is read by that same id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Trip', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    expect(await archive(ann.token, groupId)).toMatchObject({ status: 204 });

    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        token: ann.token,
        body: { from: bob.id, to: ann.id, amount: 100 },
      }),
    ).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: ann.token })).toMatchObject({
      status: 200,
      body: [],
    });
  });
});

describe('Ledger → Groups (MemberBalances)', () => {
  it('an expense Ledger records in a group made in Groups counts in the balance Groups reads when it archives, by the same group id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Trip', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    await joinGroup(groupId, bob);
    const dinner = await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    const expenseId = (dinner.body as { id: string }).id;

    expect(await archive(ann.token, groupId)).toMatchObject({
      status: 422,
      body: { type: 'GroupNotSettled' },
    });
    expect(await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token })).toMatchObject({
      status: 200,
    });
    expect(await read(ann.token, groupId)).not.toHaveProperty('body.archivedAt');
  });
});
