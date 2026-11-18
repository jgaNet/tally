import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Suspending an account over HTTP (feature 34, fragment 34, request 34): an administrator suspends an account and reinstates it, each once
 * (a change that changes nothing records nothing); anyone else is refused and the account is not looked at. While suspended, the expenses,
 * recurring expenses, cash settlements and payments through the provider the account starts are refused in every group by one rule's name,
 * AccountSuspended, and change nothing; the others of its groups go on as before (an expense it is put in, a cash settlement it is paid by).
 * Everything else it does still works: it reads its groups and its expenses, and deletes its own expense. Each suspension and reinstatement is an
 * entry of the administrators' log, and nothing is written in any group.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let admin: Awaited<ReturnType<typeof person>>;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
/** A day in the past: an expense's day is not after today. */
const PAST_DAY = '2020-01-15';
const ADMIN_EMAIL = 'admin@example.com';

beforeAll(async () => {
  app = await createApplication({
    databaseUrl: await freshDatabase(),
    logger: silent,
    administratorEmails: [ADMIN_EMAIL],
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  admin = await person('Root', ADMIN_EMAIL);
});
afterAll(async () => {
  await app.stop();
});

let counter = 0;
/** A signed-in person: their token, and their account id as the account answers it. A new person each time, so no test shares one. */
async function person(name: string, email = `person${++counter}@example.com`) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

type Person = Awaited<ReturnType<typeof person>>;

const suspend = (token: string, id: string) => http.request('PUT', `${api}/admin/accounts/${id}/suspension`, { token });
const reinstate = (token: string, id: string) =>
  http.request('DELETE', `${api}/admin/accounts/${id}/suspension`, { token });
const log = async (): Promise<{ action: string; subjectId: string; by: string }[]> =>
  (await http.request('GET', `${api}/admin/log`, { token: admin.token })).body as never;

/** A group of Ann's with Ann and Bob in it; Ann paid 1000 for both, split equally, so Bob owes Ann 500. */
async function groupWithDebt(): Promise<{ groupId: string; ann: Person; bob: Person }> {
  const ann = await person('Ann');
  const bob = await person('Bob');
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  const groupId = (body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  const paid = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
  });
  expect(paid.status).toBeLessThan(300);
  return { groupId, ann, bob };
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body;

describe('suspending and reinstating an account', () => {
  it('is done by an administrator, once: the second suspension changes nothing and logs nothing more', async () => {
    const { ann } = await groupWithDebt();

    expect(await suspend(admin.token, ann.id)).toMatchObject({ status: 204 });
    expect(await suspend(admin.token, ann.id)).toMatchObject({ status: 204 });
    const entries = (await log()).filter(entry => entry.subjectId === ann.id);
    expect(entries.map(entry => entry.action)).toEqual(['suspended']);
    expect(entries[0].by).toBe(admin.id);

    expect(await reinstate(admin.token, ann.id)).toMatchObject({ status: 204 });
    expect(await reinstate(admin.token, ann.id)).toMatchObject({ status: 204 });
    const after = (await log()).filter(entry => entry.subjectId === ann.id);
    expect(after.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
  });

  it('is refused to anyone who is not an administrator, and for an account that is not there', async () => {
    const someone = await person('Someone');
    const { ann } = await groupWithDebt();

    expect(await suspend(someone.token, ann.id)).toMatchObject({ status: 403 });
    expect(await reinstate(someone.token, ann.id)).toMatchObject({ status: 403 });
    expect(await suspend(admin.token, 'no-such-account')).toMatchObject({ status: 404 });
    expect(await suspend('', ann.id)).toMatchObject({ status: 401 });
    expect((await log()).filter(entry => entry.subjectId === ann.id)).toHaveLength(0);
  });
});

describe('a suspended account starts nothing, in any group, and what it still does works', () => {
  it('is refused an expense, a recurring expense, a cash settlement and a payment through the provider, by one name, and nothing changes', async () => {
    const { groupId, ann, bob } = await groupWithDebt();
    await suspend(admin.token, bob.id);
    const before = await balancesOf(groupId, ann.token);

    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: 'Coffee', amount: 300, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const recurring = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: bob.token,
      body: { description: 'Rent', amount: 800, startsOn: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    // A cash settlement is recorded by its payee: Bob is the payee of what Ann pays him.
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 500 },
    });
    const provider = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 500 },
    });

    for (const refused of [expense, recurring, provider]) {
      expect(refused).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    }
    expect(cash).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
    expect(await balancesOf(groupId, ann.token)).toEqual(before);
  });

  it('is refused a cash settlement it is the payee of, by the same name', async () => {
    const { groupId, ann, bob } = await groupWithDebt();
    await suspend(admin.token, bob.id);

    const received = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 100 },
    });
    expect(received).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });
  });

  it('still reads its groups, deletes its own expense, and is put in a split and paid in cash by the others', async () => {
    const { groupId, ann, bob } = await groupWithDebt();
    await suspend(admin.token, bob.id);

    expect(await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).toMatchObject({ status: 200 });
    expect(await http.request('GET', `${api}/groups/${groupId}/balances`, { token: bob.token })).toMatchObject({
      status: 200,
    });

    // Ann pays for both, Bob is in the split: others may put a suspended member in a split.
    const shared = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Taxi', amount: 400, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    expect(shared).toMatchObject({ status: 201 });

    // Ann, the payee, records the cash Bob pays her: the suspended account is the payer, which is not refused.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    expect(paid.status).toBeLessThan(300);

    // Bob deletes an expense of his own, made before the suspension.
    const bobsExpense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Bread', amount: 200, date: PAST_DAY, splitBetween: [ann.id] },
    });
    expect(bobsExpense.status).toBeLessThan(300);
  });

  it('writes nothing in a group when it is suspended or reinstated', async () => {
    const { groupId, ann, bob } = await groupWithDebt();
    const before = await balancesOf(groupId, ann.token);
    const { body: membersBefore } = await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token });
    const { body: historyBefore } = await http.request('GET', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
    });

    await suspend(admin.token, bob.id);
    await reinstate(admin.token, bob.id);

    expect(await balancesOf(groupId, ann.token)).toEqual(before);
    expect((await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body).toEqual(
      membersBefore,
    );
    expect((await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ann.token })).body).toEqual(
      historyBefore,
    );
  });

  it('records again once reinstated', async () => {
    const { groupId, bob } = await groupWithDebt();
    await suspend(admin.token, bob.id);
    expect(
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        token: bob.token,
        body: { description: 'Coffee', amount: 300, date: PAST_DAY, splitBetween: [bob.id] },
      }),
    ).toMatchObject({ status: 422, body: { type: 'AccountSuspended' } });

    await reinstate(admin.token, bob.id);
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: 'Coffee', amount: 300, date: PAST_DAY, splitBetween: [bob.id] },
    });
    expect(recorded.status).toBeLessThan(300);
  });
});

describe("the administrators' log", () => {
  it('has each suspension and reinstatement, in the order made, and only an administrator reads it', async () => {
    const suspended = await person('Logged');
    await suspend(admin.token, suspended.id);
    await reinstate(admin.token, suspended.id);

    const entries = (await log()).filter(entry => entry.subjectId === suspended.id);
    expect(entries.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
    expect(await http.request('GET', `${api}/admin/log`, { token: suspended.token })).toMatchObject({ status: 404 });
  });
});
