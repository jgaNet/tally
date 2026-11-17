import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The balances over HTTP, against a database file (request 5, fragment 6): every member's balance in the order they joined,
 * a member with nothing recorded at 0, the zero sum under many expenses recorded at once and read through a second server on
 * the same file, and the same 404 for a group the caller is not in as for one that does not exist.
 */
let directory: string;
let app: FastifyApplication;
let other: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-balances-'));
  const databasePath = join(directory, 'tally.sqlite');
  app = await createApplication({ databasePath, logger: silent });
  await app.start(0);
  other = await createApplication({ databasePath, logger: silent });
  await other.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  carol = await person('Carol', 'carol@example.com');
  dana = await person('Dana', 'dana@example.com');
});
afterAll(async () => {
  await other.stop();
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

const record = (token: string | undefined, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const balances = (token: string | undefined, groupId: string, server = http, base = api) =>
  server.request('GET', `${base}/groups/${groupId}/balances`, { token });

describe("a group's balances", () => {
  it('answers every member, in the order they joined, with a member who has recorded nothing at 0', async () => {
    const groupId = await createGroup('Trip');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);

    const before = await balances(ann.token, groupId);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
      { memberId: carol.id, balance: 0 },
    ]);

    await record(ann.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id, carol.id],
    });
    await record(bob.token, groupId, {
      description: 'Taxi',
      amount: 500,
      date: PAST_DAY,
      splitBetween: [bob.id, carol.id],
    });

    const after = await balances(carol.token, groupId);
    expect(after.status).toBe(200);
    // Groceries, 1000 paid by Ann and split 334 / 333 / 333 (the remainder to the first member listed, Ann): Ann +666, Bob -333, Carol -333.
    // Taxi, 500 paid by Bob and split 250 / 250: Bob +250, Carol -250.
    expect(after.body).toEqual([
      { memberId: ann.id, balance: 666 },
      { memberId: bob.id, balance: -333 + 250 },
      { memberId: carol.id, balance: -333 - 250 },
    ]);
    const total = (after.body as { balance: number }[]).reduce((sum, row) => sum + row.balance, 0);
    expect(total).toBe(0);
  });

  it('answers a group the caller is not in with the same 404 as a group that does not exist', async () => {
    const groupId = await createGroup('Only us');
    const stranger = await balances(dana.token, groupId);
    const missing = await balances(dana.token, 'no-such-group');
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('refuses a caller who is not signed in with 401', async () => {
    const groupId = await createGroup();
    const { status } = await balances(undefined, groupId);
    expect(status).toBe(401);
  });

  it('keeps the zero sum when many expenses are recorded at once, each counted once, and reads them the same from another server', async () => {
    const groupId = await createGroup('Many');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, carol);
    const payers = [ann, bob, carol];

    const recorded = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const payer = payers[i % payers.length];
        const split = i % 2 === 0 ? [ann.id, bob.id, carol.id] : [payer.id, ann.id];
        const withPayer = Array.from(new Set([payer.id, ...split]));
        return record(payer.token, groupId, {
          description: `Expense ${i}`,
          amount: 100 + i * 37,
          date: PAST_DAY,
          splitBetween: withPayer,
        });
      }),
    );
    expect(recorded.every(answer => answer.status === 201)).toBe(true);

    // What each expense does, read back from the expenses themselves: the payer is owed the amount, each share is owed.
    const expected = new Map<string, number>([ann.id, bob.id, carol.id].map(id => [id, 0]));
    for (const answer of recorded) {
      const { id } = answer.body as { id: string };
      const expense = (await http.request('GET', `${api}/expenses/${id}`, { token: ann.token })).body as {
        amount: number;
        paidBy: string;
        shares: { memberId: string; amount: number }[];
      };
      expected.set(expense.paidBy, (expected.get(expense.paidBy) ?? 0) + expense.amount);
      for (const share of expense.shares)
        expected.set(share.memberId, (expected.get(share.memberId) ?? 0) - share.amount);
    }

    const here = await balances(ann.token, groupId);
    const there = await balances(ann.token, groupId, apiClient(other.address), `/${other.apiPrefix}`);
    expect(here.status).toBe(200);
    expect(there.body).toEqual(here.body);
    const rows = here.body as { memberId: string; balance: number }[];
    expect(rows.map(row => row.memberId)).toEqual([ann.id, bob.id, carol.id]);
    for (const row of rows) expect(row.balance).toBe(expected.get(row.memberId));
    expect(rows.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });
});

describe('Groups → Ledger', () => {
  it('finds a group made in Groups by the id its creation answered, and reads its balances in Ledger by that same id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Made', currency: 'EUR' },
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };

    const read = await balances(ann.token, id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([{ memberId: ann.id, balance: 0 }]);
  });
});
