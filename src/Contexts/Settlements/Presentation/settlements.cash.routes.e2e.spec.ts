import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A settlement in cash over HTTP, against a database file (request 12, fragment 12): recorded by its payee, read back by a member of
 * its group, counted by the balances, the suggestions and leaving at once, not by the statement; refused when it is more than is owed,
 * and two decided at once on two servers over one file, one of them kept and the other refused.
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
  directory = mkdtempSync(join(tmpdir(), 'tally-cash-settlements-'));
  const databasePath = join(directory, 'tally.sqlite');
  app = await createApplication({ databasePath, logger: silent });
  await app.start(0);
  other = await createApplication({ databasePath, logger: silent });
  await other.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
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
const settle = (token: string | undefined, groupId: string, body: unknown, server = http, base = api) =>
  server.request('POST', `${base}/groups/${groupId}/settlements/cash`, { token, body });
const balances = (groupId: string) => http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });

/**
 * A group of Ann, Bob and Cy in which Ann paid 3000 for all three, split equally: Ann is owed 2000, Bob and Cy each owe 1000.
 */
const threeOwing = async () => {
  const groupId = await createGroup();
  await joinGroup(groupId, bob);
  await joinGroup(groupId, cy);
  await record(ann.token, groupId, {
    description: 'Dinner',
    amount: 3000,
    date: PAST_DAY,
    splitBetween: [ann.id, bob.id, cy.id],
  });
  return groupId;
};

describe('a cash settlement', () => {
  it('is recorded by its payee, read back by a member, and counted by the balances, not by the statement', async () => {
    const groupId = await threeOwing();

    const recorded = await settle(ann.token, groupId, { from: bob.id, amount: 1000 });
    expect(recorded.status).toBe(201);
    const id = (recorded.body as { id: string }).id;

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 1000,
      method: 'cash',
      status: 'paid',
      at: expect.any(String),
    });

    expect((await balances(groupId)).body).toEqual([
      { memberId: ann.id, balance: 1000 },
      { memberId: bob.id, balance: 0 },
      { memberId: cy.id, balance: -1000 },
    ]);

    // The statement lists expenses only: Bob's is what the expense gives him, not what he has settled.
    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${bob.id}/statement`, {
      token: ann.token,
    });
    expect((statement.body as { balance: number }).balance).toBe(-1000);

    // Every balance is even now, so the suggestion has no transfer left to make.
    const suggested = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(suggested.body).toEqual([{ from: cy.id, to: ann.id, amount: 1000 }]);
  });

  it('counts for leaving: a member with a balance of 0 after settling may leave, one still owing may not', async () => {
    const groupId = await threeOwing();

    const before = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: cy.token });
    expect(before.status).toBeGreaterThanOrEqual(400);

    expect((await settle(ann.token, groupId, { from: cy.id, amount: 1000 })).status).toBe(201);
    const after = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: cy.token });
    expect(after.status).toBeLessThan(300);
  });

  it('is refused when it is more than the payer owes, and nothing changes', async () => {
    const groupId = await threeOwing();

    const refused = await settle(ann.token, groupId, { from: bob.id, amount: 1500 });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'MoreThanPayerOwes', message: expect.any(String) });
    expect((await balances(groupId)).body).toEqual([
      { memberId: ann.id, balance: 2000 },
      { memberId: bob.id, balance: -1000 },
      { memberId: cy.id, balance: -1000 },
    ]);
  });

  it('is refused for an amount below 1, a payer who is the payee, and a payer who is not a member', async () => {
    const groupId = await threeOwing();

    expect((await settle(ann.token, groupId, { from: bob.id, amount: 0 })).body).toMatchObject({
      type: 'InvalidSettlementAmount',
    });
    expect((await settle(ann.token, groupId, { from: ann.id, amount: 100 })).body).toMatchObject({
      type: 'PayeeIsPayer',
    });
    expect((await settle(ann.token, groupId, { from: eve.id, amount: 100 })).body).toMatchObject({
      type: 'PayerNotInGroup',
    });
  });

  it('answers 400 for a body of the wrong shape, 401 with no caller, and the group 404 to one who is not in it', async () => {
    const groupId = await threeOwing();

    expect((await settle(ann.token, groupId, { from: bob.id, amount: '1000' })).status).toBe(400);
    expect((await settle(undefined, groupId, { from: bob.id, amount: 1000 })).status).toBe(401);
    expect((await settle(eve.token, groupId, { from: bob.id, amount: 1000 })).status).toBe(404);
  });

  it('is read by a member of its group only: to anyone else it does not exist', async () => {
    const groupId = await threeOwing();
    const id = (await settle(ann.token, groupId, { from: bob.id, amount: 1000 })).body as { id: string };

    expect((await http.request('GET', `${api}/settlements/${id.id}`, { token: eve.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/settlements/${id.id}`, { token: undefined })).status).toBe(401);
    expect(
      (await http.request('GET', `${api}/settlements/00000000-0000-0000-0000-000000000000`, { token: ann.token }))
        .status,
    ).toBe(404);
  });

  it('decided at once, on two servers over one file, is kept once: the other is decided again on what is left', async () => {
    const groupId = await threeOwing();

    // Bob owes 1000; two settlements of 600 from him to Ann, sent at the same moment to two servers.
    const [first, second] = await Promise.all([
      settle(ann.token, groupId, { from: bob.id, amount: 600 }),
      settle(ann.token, groupId, { from: bob.id, amount: 600 }, apiClient(other.address), `/${other.apiPrefix}`),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 422]);
    const refused = first.status === 422 ? first : second;
    expect(refused.body).toMatchObject({ type: 'MoreThanPayerOwes' });
    expect((await balances(groupId)).body).toEqual([
      { memberId: ann.id, balance: 1400 },
      { memberId: bob.id, balance: -400 },
      { memberId: cy.id, balance: -1000 },
    ]);
  });
});
