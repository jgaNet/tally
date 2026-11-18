import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Deleting an account over HTTP (feature 35, fragment 35, request 35): a signed-in person deletes their own account, refused with 409 while a
 * group they own has another member. Once deleted, nobody signs in with its email and password, its token proves nothing, and its email is free
 * for a new account. In every group it was in it stays a member, named `Deleted account`, with its balance, so the balances still add up to 0;
 * it is in no new split, and the expenses it paid read as before.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
/** A day in the past: an expense's day is not after today. */
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
});

let counter = 0;
/** A signed-in person: their token, their account id and their email. A new person each time, so no test shares one. */
async function person(name: string, email = `deleter${++counter}@example.com`) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name, email };
}

type Person = Awaited<ReturnType<typeof person>>;

const deleteMe = (token: string) => http.request('DELETE', `${api}/accounts/me`, { token });

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

describe('deleting an account', () => {
  it('is refused with 409, and nothing changes, while a group the person owns has another member', async () => {
    const { ann, bob, groupId } = await groupWithDebt();

    const refused = await deleteMe(ann.token);

    expect(refused).toMatchObject({ status: 409, body: { type: 'OwnedGroupHasMembers' } });
    // Ann is still there: signed in, and still in the group with Bob.
    const me = await http.request('GET', `${api}/accounts/me`, { token: ann.token });
    expect(me.status).toBe(200);
    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: bob.token })).body as {
      name: string;
    }[];
    expect(members.map(member => member.name)).toEqual(['Ann', 'Bob']);
  });

  it('is answered 401 to a request with no caller, before anything runs', async () => {
    const answer = await http.request('DELETE', `${api}/accounts/me`);
    expect(answer.status).toBe(401);
  });

  it('keeps a member in the group, named Deleted account, with the balance it had; the balances still add up to 0', async () => {
    const { groupId, ann, bob } = await groupWithDebt();

    const gone = await deleteMe(bob.token);
    expect(gone.status).toBe(204);

    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
      name: string;
      role: string;
    }[];
    expect(members.find(member => member.memberId === bob.id)).toMatchObject({
      name: 'Deleted account',
      role: 'member',
    });

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(balance => balance.memberId === bob.id)?.balance).toBe(-500);
    expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
  });

  it('is signed in to by nobody, its token proves nothing, and its email is free for a new account', async () => {
    const bob = await person('Bob');
    expect((await deleteMe(bob.token)).status).toBe(204);

    const login = await http.request('POST', `${api}/accounts/login`, {
      body: { email: bob.email, password },
    });
    expect(login.status).toBe(401);
    const me = await http.request('GET', `${api}/accounts/me`, { token: bob.token });
    expect(me.status).toBe(401);

    const again = await http.request('POST', `${api}/accounts`, {
      body: { email: bob.email, password, name: 'Someone Else' },
    });
    expect(again.status).toBeLessThan(300);
    const second = await http.request('POST', `${api}/accounts/login`, { body: { email: bob.email, password } });
    expect(second.status).toBe(200);
    const mine = await http.request('GET', `${api}/accounts/me`, { token: (second.body as { token: string }).token });
    expect(mine.body).toMatchObject({ name: 'Someone Else' });
    expect((mine.body as { id: string }).id).not.toBe(bob.id);
  });

  it('is in no new split: an expense that puts a deleted account in it is refused by name', async () => {
    const { groupId, ann, bob } = await groupWithDebt();
    expect((await deleteMe(bob.token)).status).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Taxi', amount: 600, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });

    expect(refused).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });
  });
});
