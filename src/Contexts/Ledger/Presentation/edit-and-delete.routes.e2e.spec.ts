import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Editing and deleting an expense over HTTP, against a database file (request 6): who may (its payer, the group's owner),
 * what they see of someone else's, the version an edit must be made from, two edits at once (one kept, the other refused by
 * name), and what a deletion takes out of every read and every balance.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-edit-'));
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

/** A group owned by Ann, with Bob and Carol in it (joined through an invitation, the way Groups lets them). */
const groupWithThree = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  for (const who of [bob, carol]) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitationId = (invitation.body as { id: string }).id;
    await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
  }
  return groupId;
};

const PAST_DAY = '2020-01-15';
const record = (token: string | undefined, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const recordAmong = async (who: typeof ann, groupId: string, splitBetween: string[], amount = 1000) => {
  const { body } = await record(who.token, groupId, {
    description: 'Groceries',
    amount,
    date: PAST_DAY,
    splitBetween,
  });
  return (body as { id: string }).id;
};
const read = (token: string | undefined, id: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const edit = (token: string | undefined, id: string, body: Record<string, unknown>) =>
  http.request('PUT', `${api}/expenses/${id}`, { token, body });
const remove = (token: string | undefined, id: string) => http.request('DELETE', `${api}/expenses/${id}`, { token });
const balances = async (token: string, groupId: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
    memberId: string;
    balance: number;
  }[];
const sum = (rows: { balance: number }[]) => rows.reduce((total, row) => total + row.balance, 0);

describe('editing an expense', () => {
  it('lets its payer give it again whole, from the version read, answering 204, and the read shows the new state at version 2', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, ann.id, carol.id]);

    const answer = await edit(bob.token, id, {
      description: 'Dinner',
      amount: 900,
      date: PAST_DAY,
      splitBetween: [bob.id, carol.id],
      version: 1,
    });
    expect(answer.status).toBe(204);

    const after = await read(ann.token, id);
    expect(after.body).toEqual({
      id,
      groupId,
      description: 'Dinner',
      amount: 900,
      date: PAST_DAY,
      paidBy: bob.id,
      splitKind: 'equal',
      shares: [
        { memberId: bob.id, amount: 450 },
        { memberId: carol.id, amount: 450 },
      ],
      version: 2,
    });
    const rows = await balances(ann.token, groupId);
    expect(sum(rows)).toBe(0);
    expect(rows.find(row => row.memberId === ann.id)?.balance).toBe(0);
  });

  it('lets the owner of the group edit an expense of another member, the payer staying the one who paid', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, carol.id]);

    const answer = await edit(ann.token, id, {
      description: 'Fixed',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [bob.id, ann.id, carol.id],
      version: 1,
    });
    expect(answer.status).toBe(204);
    const after = (await read(ann.token, id)).body as { paidBy: string; shares: unknown };
    expect(after.paidBy).toBe(bob.id);
    expect(after.shares).toEqual([
      { memberId: bob.id, amount: 200 },
      { memberId: ann.id, amount: 200 },
      { memberId: carol.id, amount: 200 },
    ]);
  });

  it('refuses an edit by a member who is neither the payer nor the owner, with 403 naming the rule', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id]);

    const refused = await edit(carol.token, id, {
      description: 'Mine now',
      amount: 1,
      date: PAST_DAY,
      splitBetween: [bob.id],
      version: 1,
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect(((await read(ann.token, id)).body as { description: string }).description).toBe('Groceries');
  });

  it('answers 404 to someone outside the group, the same as to an expense that does not exist', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(ann, groupId, [ann.id]);
    const body = { description: 'Mine', amount: 1, date: PAST_DAY, splitBetween: [dana.id], version: 1 };
    const stranger = await edit(dana.token, id, body);
    const missing = await edit(dana.token, 'no-such-expense', body);
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('refuses a caller who is not signed in with 401, before anything is changed', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(ann, groupId, [ann.id]);
    const { status } = await edit(undefined, id, {
      description: 'Mine',
      amount: 1,
      date: PAST_DAY,
      splitBetween: [ann.id],
      version: 1,
    });
    expect(status).toBe(401);
  });

  it('refuses an edit from a version the expense is not at, with 409 naming ExpenseChanged, and keeps nothing of it', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, ann.id]);
    const first = await edit(bob.token, id, {
      description: 'First',
      amount: 500,
      date: PAST_DAY,
      splitBetween: [bob.id, ann.id],
      version: 1,
    });
    expect(first.status).toBe(204);

    const stale = await edit(bob.token, id, {
      description: 'Stale',
      amount: 700,
      date: PAST_DAY,
      splitBetween: [bob.id],
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ type: 'ExpenseChanged', message: expect.any(String) });
    expect(((await read(ann.token, id)).body as { description: string }).description).toBe('First');
  });

  it('keeps exactly one of two edits made at once from the same version, refuses the other by name, and the balances add up to 0', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, ann.id, carol.id]);
    const byBob = {
      description: 'By payer',
      amount: 300,
      date: PAST_DAY,
      splitBetween: [bob.id, carol.id],
      version: 1,
    };
    const byAnn = {
      description: 'By owner',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [ann.id, carol.id],
      version: 1,
    };

    const [a, b] = await Promise.all([edit(bob.token, id, byBob), edit(ann.token, id, byAnn)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 409]);

    const refused = a.status === 409 ? a : b;
    expect(refused.body).toEqual({ type: 'ExpenseChanged', message: expect.any(String) });

    const kept = (await read(ann.token, id)).body as { description: string; amount: number; version: number };
    const keptBy = kept.description === 'By payer' ? byBob : byAnn;
    expect(kept).toMatchObject({ amount: keptBy.amount, version: 2 });
    expect(sum(await balances(ann.token, groupId))).toBe(0);
  });

  it('refuses a body of the wrong shape with 400, and a value the domain refuses with 422', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(ann, groupId, [ann.id]);
    const wrongShape = await edit(ann.token, id, {
      description: 'x',
      amount: 1,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(wrongShape.status).toBe(400);

    const refused = await edit(ann.token, id, {
      description: 'x',
      amount: 0,
      date: PAST_DAY,
      splitBetween: [ann.id],
      version: 1,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'InvalidExpenseAmount', message: expect.any(String) });
  });

  it('refuses an edit that leaves the payer out of the split, with 422 naming PayerNotInSplit', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, carol.id]);
    const refused = await edit(bob.token, id, {
      description: 'Without me',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [carol.id],
      version: 1,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'PayerNotInSplit', message: expect.any(String) });
  });
});

describe('deleting an expense', () => {
  it('lets its payer delete it: it is not read any more, and it counts in no balance', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id, ann.id, carol.id]);
    expect(sum(await balances(ann.token, groupId))).toBe(0);
    expect((await balances(ann.token, groupId)).find(row => row.memberId === bob.id)?.balance).toBe(666);

    const answer = await remove(bob.token, id);
    expect(answer.status).toBe(204);

    expect((await read(ann.token, id)).status).toBe(404);
    const rows = await balances(ann.token, groupId);
    expect(rows.every(row => row.balance === 0)).toBe(true);
  });

  it('lets the owner of the group delete an expense of another member', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id]);
    expect((await remove(ann.token, id)).status).toBe(204);
    expect((await read(ann.token, id)).status).toBe(404);
  });

  it('refuses a deletion by another member with 403, and one by someone outside the group with the same 404 as a missing expense', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(bob, groupId, [bob.id]);
    const other = await remove(carol.token, id);
    expect(other.status).toBe(403);
    expect(other.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect((await read(ann.token, id)).status).toBe(200);

    const stranger = await remove(dana.token, id);
    const missing = await remove(dana.token, 'no-such-expense');
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('refuses a deletion by a caller who is not signed in with 401', async () => {
    const groupId = await groupWithThree();
    const id = await recordAmong(ann, groupId, [ann.id]);
    expect((await remove(undefined, id)).status).toBe(401);
  });
});
