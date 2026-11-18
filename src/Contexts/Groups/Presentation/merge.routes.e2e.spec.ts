import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Merging two groups over HTTP (feature 31, fragment 31, request 31): the owner of both merges one into the other, the group merged is
 * gone at once, and what it held is the group kept's within a moment: its members in the order they joined, its expenses and settlements
 * (with their ids), and its balances, which add up to 0 throughout. The refusals by the rule's name, and the people for whom a group
 * is not there.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-merge-'));
  const started = await createApplication({ databaseUrl: await freshDatabase(), logger: silent });
  await started.start(0);
  app = started;
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann-merge@example.com');
  bob = await person('Bob', 'bob-merge@example.com');
  carol = await person('Carol', 'carol-merge@example.com');
  dan = await person('Dan', 'dan-merge@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

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
let dan: Awaited<ReturnType<typeof person>>;

const createGroup = async (owner: { token: string }, name: string, currency = 'EUR'): Promise<string> => {
  const { body } = await http.request('POST', `${api}/groups`, { token: owner.token, body: { name, currency } });
  return (body as { id: string }).id;
};
const invite = async (owner: { token: string }, groupId: string): Promise<string> => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  return (invitation.body as { id: string }).id;
};
const joinGroup = async (owner: { token: string }, groupId: string, who: { token: string }) => {
  const invitationId = await invite(owner, groupId);
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};
const merge = (token: string, groupId: string, from: string) =>
  http.request('POST', `${api}/groups/${groupId}/merge`, { token, body: { from } });
const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const balancesOf = async (token: string, groupId: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

/** Reads what a test waits for, again and again, until it holds or the polls run out: the reaction runs soon after the merge. */
async function eventually<T>(read: () => Promise<T>, holds: (value: T) => boolean, polls = 200): Promise<T> {
  let value = await read();
  for (let poll = 0; poll < polls && !holds(value); poll++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describe('merging two groups', () => {
  it('moves the members, the expenses, the settlements and the balances to the group kept; the group merged is gone at once', async () => {
    const kept = await createGroup(ann, 'Rent');
    const merged = await createGroup(ann, 'Groceries');
    await joinGroup(ann, kept, bob);
    await joinGroup(ann, merged, carol);
    await joinGroup(ann, merged, dan);
    // An invitation made for the group merged before the merge: it lets no one join once the group is merged.
    const stale = await invite(ann, merged);
    // Dan leaves the group merged with a balance of 0: a former member of the group kept after the merge.
    await http.request('POST', `${api}/groups/${merged}/leave`, { token: dan.token });
    const groceries = await record(ann.token, merged, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id, carol.id],
    });
    await record(ann.token, kept, {
      description: 'Rent share',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    const settled = await http.request('POST', `${api}/groups/${merged}/settlements/cash`, {
      token: ann.token,
      body: { from: carol.id, to: ann.id, amount: 500 },
    });
    expect(settled.status).toBeLessThan(300);
    const groceriesId = (groceries.body as { id: string }).id;
    const settlementId = (settled.body as { id: string }).id;

    expect(await merge(ann.token, kept, merged)).toMatchObject({ status: 204 });

    // The group merged is gone at once: not found, and nothing is listed for it.
    expect(await http.request('GET', `${api}/groups/${merged}`, { token: ann.token })).toMatchObject({ status: 404 });
    const mine = (await http.request('GET', `${api}/groups/mine`, { token: ann.token })).body as { id: string }[];
    expect(mine.map(group => group.id)).toContain(kept);
    expect(mine.map(group => group.id)).not.toContain(merged);

    // Its members join the group kept after its members, in the order they had joined the group merged.
    const members = (await http.request('GET', `${api}/groups/${kept}/members`, { token: ann.token })).body as {
      memberId: string;
    }[];
    expect(members.map(member => member.memberId)).toEqual([ann.id, bob.id, carol.id]);

    // A former member of the group merged is a former member of the group kept: their statement is read there.
    expect(
      (await http.request('GET', `${api}/groups/${kept}/members/${dan.id}/statement`, { token: ann.token })).status,
    ).toBe(200);

    // The expense keeps its id, and reads in the group kept; the balances add up to 0 once the reaction has run.
    const moved = await eventually(
      () => http.request('GET', `${api}/expenses/${groceriesId}`, { token: ann.token }),
      response => (response.body as { groupId?: string }).groupId === kept,
    );
    expect(moved).toMatchObject({ status: 200, body: { id: groceriesId, groupId: kept, amount: 1000 } });
    const balances = await eventually(
      () => balancesOf(ann.token, kept),
      values => Object.keys(values).length === 3 && values[ann.id] === 300,
    );
    expect(balances).toEqual({ [ann.id]: 300, [bob.id]: -300, [carol.id]: 0 });
    expect(Object.values(balances).reduce((sum, value) => sum + value, 0)).toBe(0);

    // The settlement keeps its id and status, in the group kept.
    const settlements = await eventually(
      async () =>
        (
          (await http.request('GET', `${api}/groups/${kept}/settlements`, { token: ann.token })).body as {
            id: string;
          }[]
        ).map(row => row.id),
      ids => ids.includes(settlementId),
    );
    expect(settlements).toContain(settlementId);

    // The audit of the group merged is the group kept's: the expense recorded in it is there, with its id, as it was written.
    const audit = await eventually(
      async () =>
        (
          (await http.request('GET', `${api}/groups/${kept}/audit`, { token: ann.token })).body as {
            subjectId: string;
          }[]
        ).map(entry => entry.subjectId),
      subjects => subjects.includes(groceriesId),
    );
    expect(audit).toContain(groceriesId);

    // An invitation made for the group merged lets no one join it.
    expect(await http.request('POST', `${api}/invitations/${stale}/accept`, { token: bob.token })).toMatchObject({
      status: 404,
    });
    expect(await http.request('POST', `${api}/groups/${merged}/invitations`, { token: ann.token })).toMatchObject({
      status: 404,
    });
  });

  it('refuses a merge the caller does not own both of, into itself, across currencies, or with an archived group, or a group they are not in', async () => {
    const owned = await createGroup(ann, 'Ann only');
    const someoneElses = await createGroup(bob, 'Bob only');
    await joinGroup(bob, someoneElses, ann);
    expect(await merge(ann.token, owned, someoneElses)).toMatchObject({ status: 403 });
    expect(await merge(ann.token, owned, owned)).toMatchObject({ status: 422 });

    const usd = await createGroup(ann, 'Dollars', 'USD');
    expect(await merge(ann.token, owned, usd)).toMatchObject({ status: 422 });

    const archived = await createGroup(ann, 'Done');
    expect(await http.request('POST', `${api}/groups/${archived}/archive`, { token: ann.token })).toMatchObject({
      status: 204,
    });
    expect(await merge(ann.token, owned, archived)).toMatchObject({ status: 422 });

    const stranger = await createGroup(bob, 'Bob alone');
    expect(await merge(ann.token, owned, stranger)).toMatchObject({ status: 404 });
    expect(await merge(ann.token, stranger, owned)).toMatchObject({ status: 404 });

    expect(await http.request('POST', `${api}/groups/${owned}/merge`, { token: ann.token, body: {} })).toMatchObject({
      status: 400,
    });
  });
});
