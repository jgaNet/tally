import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Recording and reading expenses over HTTP, against a database file: the API's answers (fragment 5), who may record into a
 * group and who may read an expense, the equal split with the remainder to the first member listed, and the refusals the domain makes.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-expenses-'));
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent });
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

/** A day in the past, and one far after any day the tests run on: the rule is about today, not the machine's clock. */
const PAST_DAY = '2020-01-15';
const FUTURE_DAY = '2999-12-31';

const record = (token: string | undefined, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const read = (token: string | undefined, id: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('Groups → Ledger', () => {
  it('splits an expense between members of the group, one of whom has just joined, and reads it back by the id it answered', async () => {
    const groupId = await createGroup('Trip');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);

    const recorded = await record(ann.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id, carol.id],
    });
    expect(recorded.status).toBe(201);
    const { id } = recorded.body as { id: string };

    const read1 = await read(bob.token, id);
    expect(read1.status).toBe(200);
    expect(read1.body).toEqual({
      id,
      groupId,
      category: 'other',
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      paidBy: ann.id,
      splitKind: 'equal',
      shares: [
        { memberId: ann.id, amount: 334 },
        { memberId: bob.id, amount: 333 },
        { memberId: carol.id, amount: 333 },
      ],
      version: 1,
    });
  });

  it('refuses a split with a person who is not a member of the group, naming the rule', async () => {
    const groupId = await createGroup('Only us');
    const refused = await record(ann.token, groupId, {
      description: 'Rent',
      amount: 500,
      date: PAST_DAY,
      splitBetween: [ann.id, dana.id],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'SplitMemberNotInGroup', message: expect.any(String) });
  });
});

describe('recording an expense', () => {
  it('answers the new expense id, with the payer as the caller', async () => {
    const groupId = await createGroup();
    const { status, body } = await record(ann.token, groupId, {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String) });
  });

  it('refuses a caller who is not signed in with 401, before anything is recorded', async () => {
    const groupId = await createGroup();
    const { status } = await record(undefined, groupId, {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(status).toBe(401);
  });

  it('answers a group that is not there for the caller with the same 404 as one that does not exist', async () => {
    const groupId = await createGroup();
    const stranger = await record(dana.token, groupId, {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [dana.id],
    });
    const missing = await record(dana.token, 'no-such-group', {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [dana.id],
    });
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('answers a body of the wrong shape with 400', async () => {
    const groupId = await createGroup();
    const { status } = await record(ann.token, groupId, {
      description: 'Bread',
      amount: '250',
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(status).toBe(400);
  });

  const refusals: [string, () => Record<string, unknown>, string][] = [
    ['a description of only spaces', () => ({ description: '   ' }), 'InvalidExpenseDescription'],
    ['a description longer than 100 characters', () => ({ description: 'x'.repeat(101) }), 'InvalidExpenseDescription'],
    ['an amount of zero', () => ({ amount: 0 }), 'InvalidExpenseAmount'],
    ['an amount above 100 000 000', () => ({ amount: 100_000_001 }), 'InvalidExpenseAmount'],
    ['a day that is not in the calendar', () => ({ date: '2026-02-30' }), 'InvalidExpenseDate'],
    ['a day after today in UTC', () => ({ date: FUTURE_DAY }), 'InvalidExpenseDate'],
    ['a member listed twice', () => ({ splitBetween: [ann.id, ann.id] }), 'DuplicateSplitMember'],
    ['a split without its payer', () => ({ splitBetween: [bob.id] }), 'PayerNotInSplit'],
  ];
  it.each(refusals)('refuses %s with 422 naming %s', async (_label, override, type) => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    const body = { description: 'Bread', amount: 250, date: PAST_DAY, splitBetween: [ann.id], ...override() };
    const { status, body: answer } = await record(ann.token, groupId, body);
    expect(status).toBe(422);
    expect(answer).toEqual({ type, message: expect.any(String) });
  });
});

describe('reading an expense', () => {
  it('answers 404 to a member of another group, the same as to an expense that does not exist', async () => {
    const groupId = await createGroup();
    const { body } = await record(ann.token, groupId, {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const { id } = body as { id: string };
    const stranger = await read(dana.token, id);
    const missing = await read(dana.token, 'no-such-expense');
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('keeps the shares in the order the split was given, the remainder to the first listed, the payer wherever it stands', async () => {
    const groupId = await createGroup('Order');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);
    const { body } = await record(ann.token, groupId, {
      description: 'Taxi',
      amount: 100,
      date: PAST_DAY,
      splitBetween: [bob.id, ann.id, carol.id],
    });
    const read1 = await read(ann.token, (body as { id: string }).id);
    expect((read1.body as { shares: unknown }).shares).toEqual([
      { memberId: bob.id, amount: 34 },
      { memberId: ann.id, amount: 33 },
      { memberId: carol.id, amount: 33 },
    ]);
  });
});
