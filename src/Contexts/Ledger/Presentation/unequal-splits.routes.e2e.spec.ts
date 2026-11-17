import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Splits by exact amounts and by shares over HTTP, against a database file (request 7): the three ways of splitting an expense
 * in a body, the shape the transport refuses with 400, the values the domain refuses by name with 422, how an expense reads
 * (its `splitKind`, its shares in the order given), and what the balances count however it was split.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-splits-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
  await app.start(0);
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
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let carol: Awaited<ReturnType<typeof person>>;

/** A group owned by Ann, with Bob and Carol in it, joined through invitations. */
const groupWithThree = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Cottage', currency: 'EUR' },
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
const read = (token: string | undefined, id: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const edit = (token: string | undefined, id: string, body: Record<string, unknown>) =>
  http.request('PUT', `${api}/expenses/${id}`, { token, body });
const balances = async (token: string, groupId: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
    memberId: string;
    balance: number;
  }[];
const sum = (rows: { balance: number }[]) => rows.reduce((total, row) => total + row.balance, 0);

describe('recording an expense by exact amounts', () => {
  it('records it at once with 201, and reads it back with splitKind exact and the shares in the order given', async () => {
    const groupId = await groupWithThree();
    const answer = await record(ann.token, groupId, {
      description: 'Lobster',
      amount: 1000,
      date: PAST_DAY,
      splitExactly: [
        { memberId: bob.id, amount: 600 },
        { memberId: ann.id, amount: 300 },
        { memberId: carol.id, amount: 100 },
      ],
    });
    expect(answer.status).toBe(201);
    const id = (answer.body as { id: string }).id;

    expect((await read(bob.token, id)).body).toEqual({
      id,
      groupId,
      description: 'Lobster',
      amount: 1000,
      date: PAST_DAY,
      paidBy: ann.id,
      splitKind: 'exact',
      shares: [
        { memberId: bob.id, amount: 600 },
        { memberId: ann.id, amount: 300 },
        { memberId: carol.id, amount: 100 },
      ],
      version: 1,
    });
  });

  it('counts each member’s exact share in the balances, the payer owed the rest, and they add up to 0', async () => {
    const groupId = await groupWithThree();
    await record(ann.token, groupId, {
      description: 'Lobster',
      amount: 1000,
      date: PAST_DAY,
      splitExactly: [
        { memberId: ann.id, amount: 0 },
        { memberId: bob.id, amount: 600 },
        { memberId: carol.id, amount: 400 },
      ],
    });
    const rows = await balances(ann.token, groupId);
    expect(rows.find(row => row.memberId === ann.id)?.balance).toBe(1000);
    expect(rows.find(row => row.memberId === bob.id)?.balance).toBe(-600);
    expect(rows.find(row => row.memberId === carol.id)?.balance).toBe(-400);
    expect(sum(rows)).toBe(0);
  });

  it.each([
    [
      'not adding up to the amount',
      [
        { memberId: 'ann', amount: 600 },
        { memberId: 'bob', amount: 300 },
      ],
      'SplitAmountsDoNotAddUp',
    ],
    [
      'a negative amount',
      [
        { memberId: 'ann', amount: 1100 },
        { memberId: 'bob', amount: -100 },
      ],
      'InvalidSplitAmount',
    ],
    [
      'a member listed twice',
      [
        { memberId: 'ann', amount: 500 },
        { memberId: 'ann', amount: 500 },
      ],
      'DuplicateSplitMember',
    ],
    ['a split without its payer', [{ memberId: 'bob', amount: 1000 }], 'PayerNotInSplit'],
  ])('refuses amounts %s with 422 naming %s', async (_label, shape, name) => {
    const groupId = await groupWithThree();
    const members = { ann: ann.id, bob: bob.id };
    const splitExactly = shape.map(entry => ({
      memberId: members[entry.memberId as 'ann' | 'bob'],
      amount: entry.amount,
    }));
    const refused = await record(ann.token, groupId, {
      description: 'Lobster',
      amount: 1000,
      date: PAST_DAY,
      splitExactly,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: name, message: expect.any(String) });
  });

  it('refuses a member of the split who is not of the group with 422 SplitMemberNotInGroup', async () => {
    const groupId = await groupWithThree();
    const refused = await record(ann.token, groupId, {
      description: 'Lobster',
      amount: 1000,
      date: PAST_DAY,
      splitExactly: [
        { memberId: ann.id, amount: 500 },
        { memberId: 'no-such-member', amount: 500 },
      ],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'SplitMemberNotInGroup', message: expect.any(String) });
  });
});

describe('recording an expense by shares', () => {
  it('divides by the shares with the remainder to the payer: 1001 by 2 and 1 shares, the payer second, is 667 and 334', async () => {
    const groupId = await groupWithThree();
    const answer = await record(bob.token, groupId, {
      description: 'Cottage',
      amount: 1001,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    expect(answer.status).toBe(201);
    const after = (await read(ann.token, (answer.body as { id: string }).id)).body as {
      splitKind: string;
      shares: unknown;
    };
    expect(after.splitKind).toBe('shares');
    expect(after.shares).toEqual([
      { memberId: ann.id, amount: 667 },
      { memberId: bob.id, amount: 334 },
    ]);
  });

  it('is the equal split of request 4 when every member has one share', async () => {
    const groupId = await groupWithThree();
    const answer = await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 1000,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 1 },
        { memberId: bob.id, shares: 1 },
        { memberId: carol.id, shares: 1 },
      ],
    });
    const after = (await read(ann.token, (answer.body as { id: string }).id)).body as { shares: unknown };
    expect(after.shares).toEqual([
      { memberId: ann.id, amount: 334 },
      { memberId: bob.id, amount: 333 },
      { memberId: carol.id, amount: 333 },
    ]);
  });

  it('counts the shares in the balances, however the expense was split', async () => {
    const groupId = await groupWithThree();
    await record(bob.token, groupId, {
      description: 'Cottage',
      amount: 1001,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    const rows = await balances(ann.token, groupId);
    expect(rows.find(row => row.memberId === bob.id)?.balance).toBe(667);
    expect(rows.find(row => row.memberId === ann.id)?.balance).toBe(-667);
    expect(sum(rows)).toBe(0);
  });

  it('refuses a share below 1 with 422 InvalidSplitShares', async () => {
    const groupId = await groupWithThree();
    const refused = await record(ann.token, groupId, {
      description: 'Cottage',
      amount: 1000,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 1 },
        { memberId: bob.id, shares: 0 },
      ],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'InvalidSplitShares', message: expect.any(String) });
  });
});

describe('the shape of a split in a body', () => {
  it.each([
    ['none of the three', {}],
    ['two of the three', { splitBetween: [], splitByShares: [{ memberId: 'x', shares: 1 }] }],
    [
      'all three',
      {
        splitBetween: [],
        splitExactly: [],
        splitByShares: [],
      },
    ],
    ['an exact amount that is not a number', { splitExactly: [{ memberId: 'x', amount: '600' }] }],
    ['a share that is not a whole number', { splitByShares: [{ memberId: 'x', shares: 1.5 }] }],
  ])('refuses a body with %s with 400', async (_label, split) => {
    const groupId = await groupWithThree();
    const refused = await record(ann.token, groupId, {
      description: 'Cottage',
      amount: 1000,
      date: PAST_DAY,
      ...split,
    });
    expect(refused.status).toBe(400);
  });
});

describe('editing an expense by a split of any of the three ways', () => {
  it('gives it again by shares from the version read, and reads it as splitKind shares at version 2', async () => {
    const groupId = await groupWithThree();
    const id = (
      (
        await record(ann.token, groupId, {
          description: 'Groceries',
          amount: 1000,
          date: PAST_DAY,
          splitBetween: [ann.id, bob.id],
        })
      ).body as { id: string }
    ).id;

    const answer = await edit(ann.token, id, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 1 },
        { memberId: bob.id, shares: 3 },
      ],
      version: 1,
    });
    expect(answer.status).toBe(204);

    const after = (await read(ann.token, id)).body as Record<string, unknown>;
    expect(after).toMatchObject({
      splitKind: 'shares',
      version: 2,
      shares: [
        { memberId: ann.id, amount: 250 },
        { memberId: bob.id, amount: 750 },
      ],
    });
  });

  it('changes how an expense is split by exact amounts, and the balances follow the new shares', async () => {
    const groupId = await groupWithThree();
    const id = (
      (
        await record(bob.token, groupId, {
          description: 'Boat',
          amount: 900,
          date: PAST_DAY,
          splitBetween: [bob.id, ann.id, carol.id],
        })
      ).body as { id: string }
    ).id;

    const answer = await edit(bob.token, id, {
      description: 'Boat',
      amount: 900,
      date: PAST_DAY,
      splitExactly: [
        { memberId: bob.id, amount: 0 },
        { memberId: ann.id, amount: 900 },
      ],
      version: 1,
    });
    expect(answer.status).toBe(204);
    expect(((await read(ann.token, id)).body as { splitKind: string }).splitKind).toBe('exact');

    const rows = await balances(ann.token, groupId);
    expect(rows.find(row => row.memberId === bob.id)?.balance).toBe(900);
    expect(rows.find(row => row.memberId === ann.id)?.balance).toBe(-900);
    expect(rows.find(row => row.memberId === carol.id)?.balance ?? 0).toBe(0);
    expect(sum(rows)).toBe(0);
  });

  it('refuses an edit by shares that leaves a share at 0, with 422 naming it, and changes nothing', async () => {
    const groupId = await groupWithThree();
    const id = (
      (
        await record(ann.token, groupId, {
          description: 'Groceries',
          amount: 1000,
          date: PAST_DAY,
          splitBetween: [ann.id, bob.id],
        })
      ).body as { id: string }
    ).id;

    const refused = await edit(ann.token, id, {
      description: 'Changed',
      amount: 1000,
      date: PAST_DAY,
      splitByShares: [
        { memberId: ann.id, shares: 1 },
        { memberId: bob.id, shares: 0 },
      ],
      version: 1,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'InvalidSplitShares', message: expect.any(String) });

    const after = (await read(ann.token, id)).body as { description: string; splitKind: string; version: number };
    expect(after).toMatchObject({ description: 'Groceries', splitKind: 'equal', version: 1 });
  });

  it('refuses an edit with two splits in its body with 400', async () => {
    const groupId = await groupWithThree();
    const id = (
      (
        await record(ann.token, groupId, {
          description: 'Groceries',
          amount: 1000,
          date: PAST_DAY,
          splitBetween: [ann.id],
        })
      ).body as { id: string }
    ).id;

    const refused = await edit(ann.token, id, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id],
      splitExactly: [{ memberId: ann.id, amount: 1000 }],
      version: 1,
    });
    expect(refused.status).toBe(400);
  });
});
