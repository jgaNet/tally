import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The suggested settlements over HTTP, against a database file (request 11, fragment 11): the transfers of the product's example
 * in the order made, a group with every balance at 0 answering no transfer, the same answer from a second server on the same
 * file, and the same 404 for a group the caller is not in as for one that does not exist.
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
  directory = mkdtempSync(join(tmpdir(), 'tally-settlements-'));
  const databaseUrl = await freshDatabase();
  app = await createApplication({ databaseUrl, logger: silent });
  await app.start(0);
  other = await createApplication({ databaseUrl, logger: silent });
  await other.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  dan = await person('Dan', 'dan@example.com');
  eve = await person('Eve', 'eve@example.com');
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
let cy: Awaited<ReturnType<typeof person>>;
let dan: Awaited<ReturnType<typeof person>>;
let eve: Awaited<ReturnType<typeof person>>;

const createGroup = async (name = 'Trip') => {
  const { body } = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name, currency: 'EUR' } });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: { token: string }) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = (token: string, groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
const suggested = (token: string | undefined, groupId: string, server = http, base = api) =>
  server.request('GET', `${base}/groups/${groupId}/settlements/suggested`, { token });

describe('the suggested settlements', () => {
  it('answers the product example: Ann 500, Bob 100, Cy -300, Dan -300 are settled by three transfers, in the order made', async () => {
    const groupId = await createGroup('Example');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    await joinGroup(groupId, dan);

    // Ann 600 paid for Ann and Cy, 400 for Ann and Dan; Bob 200 for Bob and Dan: Ann +500, Bob +100, Cy -300, Dan -300.
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [ann.id, cy.id],
    });
    await record(ann.token, groupId, {
      description: 'Hotel',
      amount: 400,
      date: PAST_DAY,
      splitBetween: [ann.id, dan.id],
    });
    await record(bob.token, groupId, {
      description: 'Taxi',
      amount: 200,
      date: PAST_DAY,
      splitBetween: [bob.id, dan.id],
    });

    const balances = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(balances.body).toEqual([
      { memberId: ann.id, balance: 500 },
      { memberId: bob.id, balance: 100 },
      { memberId: cy.id, balance: -300 },
      { memberId: dan.id, balance: -300 },
    ]);

    const answer = await suggested(dan.token, groupId);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: bob.id, amount: 100 },
    ]);
  });

  it('answers no transfer for a group whose every balance is 0, and reads nothing back when it is read again', async () => {
    const groupId = await createGroup('Even');
    await joinGroup(groupId, bob);
    await record(ann.token, groupId, {
      description: 'Coffee',
      amount: 800,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    await record(bob.token, groupId, {
      description: 'Cake',
      amount: 800,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const first = await suggested(ann.token, groupId);
    expect(first.status).toBe(200);
    expect(first.body).toEqual([]);
    expect((await suggested(bob.token, groupId)).body).toEqual([]);
  });

  it('is only a suggestion: reading it changes no balance', async () => {
    const groupId = await createGroup('Read only');
    await joinGroup(groupId, bob);
    await record(ann.token, groupId, {
      description: 'Rent',
      amount: 900,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const before = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
    expect((await suggested(ann.token, groupId)).body).toEqual([{ from: bob.id, to: ann.id, amount: 450 }]);
    expect((await suggested(bob.token, groupId)).body).toEqual([{ from: bob.id, to: ann.id, amount: 450 }]);
    const after = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(after.body).toEqual(before.body);
  });

  it('answers the same transfers from another server on the same file', async () => {
    const groupId = await createGroup('Shared file');
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    await record(ann.token, groupId, {
      description: 'Fuel',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id, cy.id],
    });

    const here = await suggested(ann.token, groupId);
    const there = await suggested(ann.token, groupId, apiClient(other.address), `/${other.apiPrefix}`);
    expect(here.status).toBe(200);
    expect(there.body).toEqual(here.body);
    expect(here.body).toEqual([
      { from: bob.id, to: ann.id, amount: 200 },
      { from: cy.id, to: ann.id, amount: 200 },
    ]);
  });

  it('answers a group the caller is not in with the same 404 as a group that does not exist', async () => {
    const groupId = await createGroup('Only us');
    const stranger = await suggested(eve.token, groupId);
    const missing = await suggested(eve.token, 'no-such-group');
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('refuses a caller who is not signed in with 401', async () => {
    const groupId = await createGroup();
    const { status } = await suggested(undefined, groupId);
    expect(status).toBe(401);
  });
});

describe('Groups → Settlements', () => {
  it('finds a group made in Groups by the id its creation answered, and reads its suggestion in Settlements by that same id', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Made in Groups', currency: 'EUR' },
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };

    const read = await suggested(ann.token, id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([]);
  });
});

describe('Ledger → Settlements', () => {
  it('finds a group whose expense was recorded in Ledger by the id the group was answered, and suggests what that expense leaves owed', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Recorded in Ledger', currency: 'EUR' },
    });
    const { id: groupId } = created.body as { id: string };
    await joinGroup(groupId, bob);

    const recorded = await record(ann.token, groupId, {
      description: 'Ledger entry',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);

    const read = await suggested(bob.token, groupId);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([{ from: bob.id, to: ann.id, amount: 500 }]);
  });
});
