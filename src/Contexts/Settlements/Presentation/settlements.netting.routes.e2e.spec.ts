import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Netting what two people owe each other across their groups, over HTTP (feature 32, request 32, ADR 27): the settlements it makes count
 * at once, all of them or none, and the two people read the netting; nobody else does.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-netting-'));
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent, providerUrl: '' });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  eve = await person('Eve', 'eve@example.com');
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
let eve: Awaited<ReturnType<typeof person>>;

/** A group in EUR made by Ann, with Bob in it (through an invitation). */
async function groupWithBob(name: string, currency = 'EUR'): Promise<string> {
  const created = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name, currency } });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  return groupId;
}

/** An expense in the group, paid by `payer`, split equally between Ann and Bob. */
async function expense(groupId: string, payer: { token: string }, amount: number) {
  const made = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { description: 'Shared', amount, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
  });
  expect(made.status).toBe(201);
}

/**
 * The example of the request: Ann owes Bob 300 in the flat and 200 in the trip (made after it), and Bob owes Ann 400 in the club. Bob pays
 * 600 and 400 in the first two, Ann 800 in the third, each split between the two.
 */
async function threeGroups() {
  const flat = await groupWithBob('Flat');
  await expense(flat, bob, 600);
  const trip = await groupWithBob('Trip');
  await expense(trip, bob, 400);
  const club = await groupWithBob('Club');
  await expense(club, ann, 800);
  return { flat, trip, club };
}

const net = (token: string, body: { with: string; currency: string }) =>
  http.request('POST', `${api}/nettings`, { token, body });

describe('Netting across groups (request 32)', () => {
  it('nets what two people owe each other across their groups, as settlements that count at once, in the order made', async () => {
    const { flat, trip, club } = await threeGroups();

    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(made.status).toBe(201);
    const nettingId = (made.body as { id: string }).id;

    // Ann can pay 500 (300 in the flat, 200 in the trip), Bob can pay 400 in the club: 400 is netted.
    const read = await http.request('GET', `${api}/nettings/${nettingId}`, { token: bob.token });
    expect(read.status).toBe(200);
    const netting = read.body as {
      id: string;
      by: string;
      with: string;
      currency: string;
      amount: number;
      settlements: string[];
    };
    expect(netting).toMatchObject({ id: nettingId, by: ann.id, with: bob.id, currency: 'EUR', amount: 400 });
    expect(netting.settlements).toHaveLength(3);

    // Ann pays Bob 300 in the flat and 100 in the trip; Bob pays Ann 400 in the club, the settlements in the order they were made.
    const settlements = [];
    for (const id of netting.settlements) {
      const view = (await http.request('GET', `${api}/settlements/${id}`, { token: ann.token })).body as Record<
        string,
        unknown
      >;
      settlements.push({
        groupId: view.groupId,
        from: view.from,
        to: view.to,
        amount: view.amount,
        method: view.method,
        status: view.status,
      });
    }
    expect(settlements).toEqual([
      { groupId: flat, from: ann.id, to: bob.id, amount: 300, method: 'net', status: 'paid' },
      { groupId: trip, from: ann.id, to: bob.id, amount: 100, method: 'net', status: 'paid' },
      { groupId: club, from: bob.id, to: ann.id, amount: 400, method: 'net', status: 'paid' },
    ]);
  });

  it('the settlements count at once: the balances, the statement as a settlement by netting, and the audit as paid by the one who asked', async () => {
    const { flat } = await threeGroups();
    expect((await net(ann.token, { with: bob.id, currency: 'EUR' })).status).toBe(201);

    // Ann's debt in the flat is paid by the netting, so the balances of the flat are 0 at once.
    const balances = await http.request('GET', `${api}/groups/${flat}/balances`, { token: ann.token });
    expect(balances.body).toEqual(
      expect.arrayContaining([
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ]),
    );

    const statement = await http.request('GET', `${api}/groups/${flat}/members/${ann.id}/statement`, {
      token: ann.token,
    });
    const entries = (statement.body as { entries: { description: string }[] }).entries;
    expect(entries.map(entry => entry.description)).toContain('Settlement by netting');

    const audit = await http.request('GET', `${api}/groups/${flat}/audit`, { token: ann.token });
    expect(audit.body).toContainEqual(expect.objectContaining({ action: 'settlement-paid', by: ann.id, amount: 300 }));
  });

  it('a netting is refused by name when there is nothing to net, and nothing changes', async () => {
    // Eve shares no group with Ann: nothing to net. A currency with no group is the same refusal.
    expect((await net(ann.token, { with: eve.id, currency: 'EUR' })).status).toBe(422);
    const { flat } = await threeGroups();
    expect((await net(ann.token, { with: bob.id, currency: 'USD' })).status).toBe(422);
    // With oneself it is refused too.
    expect((await net(ann.token, { with: ann.id, currency: 'EUR' })).status).toBe(422);
    // Nothing in the flat changed by a refusal.
    const balances = await http.request('GET', `${api}/groups/${flat}/balances`, { token: ann.token });
    expect(balances.body).toContainEqual({ memberId: ann.id, balance: -300 });
  });

  it('a netting made once leaves nothing to net the second time', async () => {
    await threeGroups();
    expect((await net(ann.token, { with: bob.id, currency: 'EUR' })).status).toBe(201);
    expect((await net(ann.token, { with: bob.id, currency: 'EUR' })).status).toBe(422);
  });

  it('two nettings asked at the same moment: one is made, and the other finds nothing left to net, never paying more than is owed', async () => {
    await threeGroups();
    const [first, second] = await Promise.all([
      net(ann.token, { with: bob.id, currency: 'EUR' }),
      net(ann.token, { with: bob.id, currency: 'EUR' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 422]);
  });

  it('a netting is read by the two people only: to anyone else it does not exist', async () => {
    await threeGroups();
    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const nettingId = (made.body as { id: string }).id;

    expect((await http.request('GET', `${api}/nettings/${nettingId}`, { token: bob.token })).status).toBe(200);
    expect((await http.request('GET', `${api}/nettings/${nettingId}`, { token: eve.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/nettings/${nettingId}`)).status).toBe(401);
    expect((await http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' } })).status).toBe(
      401,
    );
  });

  it('a settlement by netting is never refunded: its payee cannot refund it', async () => {
    await threeGroups();
    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const read = (
      await http.request('GET', `${api}/nettings/${(made.body as { id: string }).id}`, { token: ann.token })
    ).body as { settlements: string[] };

    // Bob is the payee of Ann's first settlement, made by netting: refused, as only a payment through the provider can be refunded.
    expect(
      (await http.request('POST', `${api}/settlements/${read.settlements[0]}/refund`, { token: bob.token })).status,
    ).toBe(422);
  });
});
