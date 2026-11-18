import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The spending insights over HTTP, against a database file (request 37, fragment 37): what a person spent, by month, currency and category,
 * across the groups they are a member of now; each person reads their own; a deleted expense and a group left count for nothing; a person in
 * no group reads no lines, and a caller with no session is refused with 401.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-insights-'));
  const databaseUrl = await freshDatabase();
  app = await createApplication({ databaseUrl, logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
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
let dana: Awaited<ReturnType<typeof person>>;

const createGroup = async (owner: { token: string }, name: string, currency: string) => {
  const { body } = await http.request('POST', `${api}/groups`, { token: owner.token, body: { name, currency } });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (owner: { token: string }, groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = async (who: { token: string }, groupId: string, body: Record<string, unknown>) => {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token: who.token, body });
  expect(answer.status).toBe(201);
  return (answer.body as { id: string }).id;
};

const insights = (token: string | undefined) => http.request('GET', `${api}/accounts/me/insights`, { token });

describe("a person's spending insights", () => {
  let flat: string;
  let trip: string;
  let groceriesApril: string;

  it('answers what each person spent, by month, then currency, then category, in the order the request gives', async () => {
    flat = await createGroup(ann, 'Flat', 'EUR');
    await joinGroup(ann, flat, bob);
    trip = await createGroup(ann, 'Trip', 'CHF');
    await joinGroup(ann, trip, bob);

    await record(ann, flat, {
      description: 'Groceries',
      amount: 8000,
      date: '2026-03-10',
      category: 'groceries',
      splitBetween: [ann.id, bob.id],
    });
    groceriesApril = await record(ann, flat, {
      description: 'Groceries again',
      amount: 7000,
      date: '2026-04-02',
      category: 'groceries',
      splitBetween: [ann.id, bob.id],
    });
    await record(bob, flat, {
      description: 'Rent',
      amount: 100000,
      date: '2026-04-01',
      category: 'rent',
      splitBetween: [bob.id],
    });
    await record(ann, trip, {
      description: 'Train',
      amount: 50000,
      date: '2026-04-20',
      category: 'travel',
      splitBetween: [ann.id, bob.id],
    });

    const annLines = await insights(ann.token);
    expect(annLines.status).toBe(200);
    expect(annLines.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
    ]);

    // Bob's own: the rent he alone was split, and his halves of the others; the April groceries come before the rent (the request's order).
    const bobLines = await insights(bob.token);
    expect(bobLines.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 3500 },
      { month: '2026-04', currency: 'EUR', category: 'rent', amount: 100000 },
    ]);
  });

  it('counts a deleted expense for nothing', async () => {
    const removed = await http.request('DELETE', `${api}/expenses/${groceriesApril}`, { token: ann.token });
    expect(removed.status).toBe(204);

    const annLines = await insights(ann.token);
    expect(annLines.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
    ]);
  });

  it('counts a group she has left for nothing, and her shares in it stay out once she is gone', async () => {
    const solo = await createGroup(bob, 'Solo', 'EUR');
    await joinGroup(bob, solo, ann);
    await record(ann, solo, {
      description: 'Coffee',
      amount: 900,
      date: '2026-05-02',
      category: 'food',
      splitBetween: [ann.id],
    });

    const before = await insights(ann.token);
    expect(before.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-05', currency: 'EUR', category: 'food', amount: 900 },
    ]);

    const left = await http.request('POST', `${api}/groups/${solo}/leave`, { token: ann.token });
    expect([200, 204]).toContain(left.status);

    const after = await insights(ann.token);
    expect(after.body).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
    ]);
  });

  it('answers a person in no group with no lines, and a caller with no session with 401', async () => {
    const none = await insights(dana.token);
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);

    const anonymous = await insights(undefined);
    expect(anonymous.status).toBe(401);
  });
});

describe('Groups → Ledger (GroupCurrency, GroupMembers)', () => {
  it('a group Groups made, found by the id its creation answered, is read by Ledger in its own currency for the members who joined it', async () => {
    // Groups answers the id of the group it makes; Ledger records in it by that id and reads its currency and members through the owned ports.
    const made = await createGroup(dana, 'Holiday', 'USD');
    await joinGroup(dana, made, bob);

    await record(dana, made, {
      description: 'Museum',
      amount: 1234,
      date: '2026-06-01',
      category: 'leisure',
      splitBetween: [dana.id],
    });
    await record(bob, made, {
      description: 'Tickets',
      amount: 500,
      date: '2026-06-01',
      category: 'leisure',
      splitBetween: [bob.id],
    });

    const danaLines = await insights(dana.token);
    expect(danaLines.body).toEqual([{ month: '2026-06', currency: 'USD', category: 'leisure', amount: 1234 }]);

    const bobLines = await insights(bob.token);
    expect(bobLines.body).toContainEqual({ month: '2026-06', currency: 'USD', category: 'leisure', amount: 500 });
  });
});
