import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does: `202`, then the operation followed to its outcome. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins, and the operation is followed. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense as a client does: the `202`, then the operation followed to its outcome. */
async function record(token: string | undefined, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** The day as the server reads it (the operation's creation time), so the spec reads no clock of its own. */
const today = () => serverToday;
const daysFromToday = (days: number) =>
  new Date(new Date(`${serverToday}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** A group of three: Alice (its owner), Bob and Carol, who joined in that order. */
async function threeMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const carol = await person('Carol');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  await join(groupId, alice, carol);
  return { alice, bob, carol, groupId };
}

describe('recording an expense, split equally', () => {
  it('answers 202, and the operation succeeds with the id of the new expense', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { answer, done } = await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, carol.id, alice.id],
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS', result: { id: expect.any(String) } });
  });

  it('splits 1000 between three members: 333 each for two, and 334 for the payer', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { done } = await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, carol.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;

    const { status, body } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    expect(status).toBe(200);
    expect(body).toEqual({
      id,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: today(),
      paidBy: alice.id,
      splitKind: 'equal',
      shares: [
        { memberId: bob.id, amount: 333 },
        { memberId: carol.id, amount: 333 },
        { memberId: alice.id, amount: 334 },
      ],
      version: 1,
    });
  });

  it('keeps the shares adding up to the amount, whatever the number of members', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { done } = await record(alice.token, groupId, {
      description: 'Rent',
      amount: 100,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const { body } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    const shares = (body as { shares: { amount: number }[] }).shares;
    expect(shares.map(share => share.amount)).toEqual([34, 33, 33]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(100);
  });

  it('lets a member who has just joined be in the split at once', async () => {
    const { alice, groupId } = await threeMembers();
    const dave = await person('Dave');
    await join(groupId, alice, dave);
    const { done } = await record(alice.token, groupId, {
      description: 'Drinks',
      amount: 2,
      date: today(),
      splitBetween: [alice.id, dave.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS' });
  });

  it('accepts a description of 100 characters, and an amount of 100 000 000', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const { done } = await record(alice.token, groupId, {
      description: 'a'.repeat(100),
      amount: 100_000_000,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['an empty description', { description: '' }, 'InvalidDescription'],
    ['a description of spaces', { description: '   ' }, 'InvalidDescription'],
    ['a description of 101 characters', { description: 'a'.repeat(101) }, 'InvalidDescription'],
    ['an amount of 0', { amount: 0 }, 'InvalidAmount'],
    ['an amount above 100 000 000', { amount: 100_000_001 }, 'InvalidAmount'],
    ['a day that is not in the calendar', { date: '2026-02-30' }, 'InvalidDate'],
    ['a date that is not a day', { date: 'yesterday' }, 'InvalidDate'],
    ['a day after today', { date: 'TOMORROW' }, 'DateInTheFuture'],
    ['a split without its payer', { splitBetween: [] }, 'PayerNotInSplit'],
    ['a member listed twice', { splitBetween: ['PAYER', 'PAYER'] }, 'MemberListedTwice'],
    ['a stranger in the split', { splitBetween: ['PAYER', 'STRANGER'] }, 'NotAGroupMember'],
  ])('refuses %s, behind the 202', async (_, changes, type) => {
    const { alice, bob, groupId } = await threeMembers();
    const stranger = await person('Stranger');
    const base = { description: 'Groceries', amount: 10, date: today(), splitBetween: ['PAYER', bob.id] };
    const body = { ...base, ...changes } as Body;
    if (body.date === 'TOMORROW') body.date = daysFromToday(1);
    body.splitBetween = (body.splitBetween as string[]).map(member =>
      member === 'PAYER' ? alice.id : member === 'STRANGER' ? stranger.id : member,
    );

    const { answer, done } = await record(alice.token, groupId, body);
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
  });

  it('refuses a payer who is not a member of the group, behind the 202', async () => {
    const { bob, carol, groupId } = await threeMembers();
    const outsider = await person('Outsider');
    const { done } = await record(outsider.token, groupId, {
      description: 'Groceries',
      amount: 10,
      date: today(),
      splitBetween: [outsider.id, bob.id, carol.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotAGroupMember' } });
  });

  it('accepts the day of today in UTC', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const { done } = await record(alice.token, groupId, {
      description: 'Today',
      amount: 5,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    expect(done).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['a missing field', { description: 'Groceries', amount: 10, splitBetween: [] }],
    [
      'an amount that is not a whole number',
      { description: 'Groceries', amount: 10.5, date: today(), splitBetween: [] },
    ],
    ['an amount that is a string', { description: 'Groceries', amount: '10', date: today(), splitBetween: [] }],
    ['a split that is not a list', { description: 'Groceries', amount: 10, date: today(), splitBetween: 'bob' }],
  ])('refuses %s at once with 400', async (_, body) => {
    const { alice, groupId } = await threeMembers();
    const { status } = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body,
      token: alice.token,
    });
    expect(status).toBe(400);
  });

  it('refuses a caller who is not signed in at once with 401', async () => {
    const { bob, groupId } = await threeMembers();
    const { status } = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Groceries', amount: 10, date: today(), splitBetween: [bob.id] },
    });
    expect(status).toBe(401);
  });
});

describe('Groups → Ledger (GroupMembers)', () => {
  it('records an expense in the group the API answered, and reads it under that same group id', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createGroup(alice);
    await join(groupId, alice, bob);

    const { done } = await record(alice.token, groupId, {
      description: 'Petrol',
      amount: 60,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const { body } = await http.get(`${api}/expenses/${id}`, { token: bob.token });
    expect(body).toMatchObject({ id, groupId, paidBy: alice.id });
  });

  it('takes the members from Groups: a stranger to the group is refused, the group having been made through the API', async () => {
    const alice = await person('Alice');
    const stranger = await person('Stranger');
    const groupId = await createGroup(alice);
    const { done } = await record(alice.token, groupId, {
      description: 'Petrol',
      amount: 60,
      date: today(),
      splitBetween: [alice.id, stranger.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotAGroupMember' } });
  });
});

describe('reading an expense', () => {
  it('lets a member of the group read it, and a stranger gets the answer for an expense that does not exist', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const stranger = await person('Reader');
    const { done } = await record(alice.token, groupId, {
      description: 'Dinner',
      amount: 40,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const id = (done as { result: { id: string } }).result.id;

    expect((await http.get(`${api}/expenses/${id}`, { token: bob.token })).status).toBe(200);
    expect((await http.get(`${api}/expenses/${id}`, { token: stranger.token })).status).toBe(404);
    expect((await http.get(`${api}/expenses/${id}`)).status).toBe(401);
  });

  it('answers 404 for an expense that was never recorded', async () => {
    const { alice } = await threeMembers();
    const { status } = await http.get(`${api}/expenses/no-such-expense`, { token: alice.token });
    expect(status).toBe(404);
  });
});

/** Edits an expense as a client does: the `202`, then the operation followed to its outcome. */
async function edit(token: string | undefined, expenseId: string, body: Body) {
  const answer = await http.request('PUT', `${api}/expenses/${expenseId}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** Deletes an expense as a client does: the `202`, then the operation followed to its outcome. */
async function remove(token: string | undefined, expenseId: string) {
  const answer = await http.request('DELETE', `${api}/expenses/${expenseId}`, { token });
  if (answer.status !== 202) return { answer, done: undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** Records an expense and answers its id and its first version. */
async function recorded(token: string, groupId: string, body: Body) {
  const { done } = await record(token, groupId, body);
  return (done as { result: { id: string } }).result.id;
}

/** The balances of a group, read by one of its members, as a map from member id to balance. */
async function balancesOf(token: string, groupId: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return new Map((body as { memberId: string; balance: number }[]).map(row => [row.memberId, row.balance]));
}

describe('editing an expense', () => {
  it('lets its payer give it again, whole: the shares are computed again, and the version goes up by one', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, carol.id, alice.id],
    });

    const { answer, done } = await edit(alice.token, id, {
      description: 'Groceries and wine',
      amount: 600,
      date: today(),
      splitBetween: [alice.id, bob.id],
      version: 1,
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS' });

    const { body } = await http.get(`${api}/expenses/${id}`, { token: bob.token });
    expect(body).toEqual({
      id,
      groupId,
      description: 'Groceries and wine',
      amount: 600,
      date: today(),
      paidBy: alice.id,
      splitKind: 'equal',
      shares: [
        { memberId: alice.id, amount: 300 },
        { memberId: bob.id, amount: 300 },
      ],
      version: 2,
    });
  });

  it('lets the owner of the group give an expense again, and the payer stays the one who paid', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(bob.token, groupId, {
      description: 'Petrol',
      amount: 90,
      date: today(),
      splitBetween: [bob.id, carol.id],
    });

    const { done } = await edit(alice.token, id, {
      description: 'Petrol, motorway',
      amount: 90,
      date: today(),
      splitBetween: [bob.id, carol.id, alice.id],
      version: 1,
    });
    expect(done).toMatchObject({ status: 'SUCCESS' });

    const { body } = await http.get(`${api}/expenses/${id}`, { token: carol.token });
    expect(body).toMatchObject({ paidBy: bob.id, version: 2 });
  });

  it('refuses a member who neither paid the expense nor owns the group, behind the 202', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
    });
    const { answer, done } = await edit(carol.token, id, {
      description: 'Dinner',
      amount: 10,
      date: today(),
      splitBetween: [alice.id, carol.id],
      version: 1,
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotAllowedToChangeExpense' } });
  });

  it('answers an expense that does not exist to a stranger, the same as one that was never recorded', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const stranger = await person('Outsider');
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { done } = await edit(stranger.token, id, {
      description: 'Dinner',
      amount: 10,
      date: today(),
      splitBetween: [alice.id, bob.id],
      version: 1,
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('refuses an edit from a version the expense has moved on from, by name', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    await edit(alice.token, id, {
      description: 'Dinner',
      amount: 40,
      date: today(),
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    const { done } = await edit(alice.token, id, {
      description: 'Dinner',
      amount: 50,
      date: today(),
      splitBetween: [alice.id, bob.id],
      version: 1,
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'ExpenseChanged' } });
    const { body } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    expect(body).toMatchObject({ amount: 40, version: 2 });
  });

  it('keeps one of two edits made at once from the same version, refuses the other, and the balances add up to 0', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
    });
    const body = (amount: number) => ({
      description: 'Groceries',
      amount,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
      version: 1,
    });

    const [first, second] = await Promise.all([edit(alice.token, id, body(900)), edit(alice.token, id, body(1200))]);
    const outcomes = [first.done, second.done].map(done => done as Body);
    const kept = outcomes.filter(done => done.status === 'SUCCESS');
    const refused = outcomes.filter(done => done.status === 'ERROR');
    expect(kept).toHaveLength(1);
    expect(refused).toMatchObject([{ error: { type: 'ExpenseChanged' } }]);

    const { body: stored } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    expect(stored).toMatchObject({ version: 2 });
    const balances = await balancesOf(alice.token, groupId);
    expect([...balances.values()].reduce((sum, balance) => sum + balance, 0)).toBe(0);
  });

  it('moves the balances with the edit: the expense counts as it is now, and not as it was', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const before = await balancesOf(alice.token, groupId);
    expect(before.get(alice.id)).toBe(30);
    expect(before.get(bob.id)).toBe(-30);

    await edit(alice.token, id, {
      description: 'Dinner',
      amount: 100,
      date: today(),
      splitBetween: [alice.id],
      version: 1,
    });
    const balances = await balancesOf(alice.token, groupId);
    expect(balances.get(alice.id)).toBe(0);
    expect(balances.get(bob.id)).toBe(0);
  });

  it('refuses a split with a member who is not in the group, and a split without the payer', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const stranger = await person('Stranger');
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const outsider = await edit(alice.token, id, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, stranger.id],
      version: 1,
    });
    expect(outsider.done).toMatchObject({ status: 'ERROR', error: { type: 'NotAGroupMember' } });
    const withoutPayer = await edit(alice.token, id, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [bob.id],
      version: 1,
    });
    expect(withoutPayer.done).toMatchObject({ status: 'ERROR', error: { type: 'PayerNotInSplit' } });
  });

  it('is refused without a signed-in caller, at once, with 401', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { status } = await http.request('PUT', `${api}/expenses/${id}`, {
      body: { description: 'Dinner', amount: 30, date: today(), splitBetween: [alice.id, bob.id], version: 1 },
    });
    expect(status).toBe(401);
  });
});

describe('deleting an expense', () => {
  it('lets its payer delete it: it is gone from every read, and from the balances', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { answer, done } = await remove(alice.token, id);
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS' });

    expect((await http.get(`${api}/expenses/${id}`, { token: alice.token })).status).toBe(404);
    const balances = await balancesOf(alice.token, groupId);
    expect(balances.get(alice.id) ?? 0).toBe(0);
    expect(balances.get(bob.id) ?? 0).toBe(0);
  });

  it('lets the owner of the group delete an expense of another member', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(bob.token, groupId, {
      description: 'Taxi',
      amount: 20,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { done } = await remove(alice.token, id);
    expect(done).toMatchObject({ status: 'SUCCESS' });
    expect((await http.get(`${api}/expenses/${id}`, { token: bob.token })).status).toBe(404);
  });

  it('refuses a member who neither paid it nor owns the group, and it stays', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
    });
    const { done } = await remove(bob.token, id);
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotAllowedToChangeExpense' } });
    expect((await http.get(`${api}/expenses/${id}`, { token: carol.token })).status).toBe(200);
  });

  it('answers a stranger the same as an expense that does not exist', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const stranger = await person('Outsider');
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { done } = await remove(stranger.token, id);
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('is refused without a signed-in caller, at once, with 401', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Dinner',
      amount: 30,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { status } = await http.request('DELETE', `${api}/expenses/${id}`);
    expect(status).toBe(401);
  });
});

describe('splitting unequally', () => {
  /** Records an expense by exact amounts, as a client does. */
  const exactly = (token: string, groupId: string, amounts: [string, number][], amount = 10) =>
    record(token, groupId, {
      description: 'Lobster',
      amount,
      date: today(),
      splitExactly: amounts.map(([memberId, share]) => ({ memberId, amount: share })),
    });

  /** Records an expense by shares, as a client does. */
  const byShares = (token: string, groupId: string, parts: [string, number][], amount: number) =>
    record(token, groupId, {
      description: 'Cottage',
      amount,
      date: today(),
      splitByShares: parts.map(([memberId, shares]) => ({ memberId, shares })),
    });

  it('splits by exact amounts, each member with their amount, in the order given, and reads it as exact', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { answer, done } = await exactly(alice.token, groupId, [
      [bob.id, 6],
      [carol.id, 0],
      [alice.id, 4],
    ]);
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS' });
    const id = (done as { result: { id: string } }).result.id;

    const { body } = await http.get(`${api}/expenses/${id}`, { token: bob.token });
    expect(body).toEqual({
      id,
      groupId,
      description: 'Lobster',
      amount: 10,
      date: today(),
      paidBy: alice.id,
      splitKind: 'exact',
      shares: [
        { memberId: bob.id, amount: 6 },
        { memberId: carol.id, amount: 0 },
        { memberId: alice.id, amount: 4 },
      ],
      version: 1,
    });
  });

  it('splits by shares: 1001 by 2 and 1 shares, the payer listed second, is 667 and 334', async () => {
    const { alice, bob, groupId } = await threeMembers();
    const { done } = await byShares(
      alice.token,
      groupId,
      [
        [bob.id, 2],
        [alice.id, 1],
      ],
      1001,
    );
    expect(done).toMatchObject({ status: 'SUCCESS' });
    const id = (done as { result: { id: string } }).result.id;

    const { body } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    expect(body).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: bob.id, amount: 667 },
        { memberId: alice.id, amount: 334 },
      ],
    });
  });

  it('splits by shares of 1, 1 and 1 as the equal split does: 333, 333 and 334', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { done } = await byShares(
      alice.token,
      groupId,
      [
        [bob.id, 1],
        [carol.id, 1],
        [alice.id, 1],
      ],
      1000,
    );
    const id = (done as { result: { id: string } }).result.id;
    const { body } = await http.get(`${api}/expenses/${id}`, { token: alice.token });
    expect(body).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: bob.id, amount: 333 },
        { memberId: carol.id, amount: 333 },
        { memberId: alice.id, amount: 334 },
      ],
    });
  });

  it.each([
    [
      'exact amounts that do not add up',
      {
        description: 'Lobster',
        amount: 10,
        date: 'TODAY',
        splitExactly: [
          { memberId: 'ALICE', amount: 4 },
          { memberId: 'BOB', amount: 5 },
        ],
      },
      'ExactAmountsDoNotAddUp',
    ],
    [
      'an exact amount below 0',
      {
        description: 'Lobster',
        amount: 10,
        date: 'TODAY',
        splitExactly: [
          { memberId: 'ALICE', amount: 11 },
          { memberId: 'BOB', amount: -1 },
        ],
      },
      'InvalidExactAmount',
    ],
    [
      'a member with less than one share',
      {
        description: 'Cottage',
        amount: 10,
        date: 'TODAY',
        splitByShares: [
          { memberId: 'ALICE', shares: 0 },
          { memberId: 'BOB', shares: 1 },
        ],
      },
      'InvalidShares',
    ],
  ])('refuses %s, behind the 202', async (_, template, type) => {
    const { alice, bob, groupId } = await threeMembers();
    const ids: Record<string, string> = { ALICE: alice.id, BOB: bob.id };
    const body = JSON.parse(
      JSON.stringify(template)
        .replace(/"(ALICE|BOB)"/g, (_m, key: string) => `"${ids[key]}"`)
        .replace('"TODAY"', `"${today()}"`),
    ) as Body;
    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token: alice.token });
    expect(answer.status).toBe(202);
    const done = await outcome((answer.body as Body).operationId as string, alice.token);
    expect(done.body).toMatchObject({ status: 'ERROR', error: { type } });
  });

  it('refuses a split whose payer is not in it, behind the 202', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { done } = await exactly(alice.token, groupId, [
      [bob.id, 5],
      [carol.id, 5],
    ]);
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'PayerNotInSplit' } });
  });

  it.each([
    ['none of the three', { description: 'Lobster', amount: 10, date: today() }],
    [
      'two of the three',
      {
        description: 'Lobster',
        amount: 10,
        date: today(),
        splitExactly: [{ memberId: 'x', amount: 10 }],
        splitByShares: [{ memberId: 'x', shares: 1 }],
      },
    ],
    [
      'an exact amount that is a string',
      { description: 'Lobster', amount: 10, date: today(), splitExactly: [{ memberId: 'x', amount: '10' }] },
    ],
    [
      'a share that is not a whole number',
      { description: 'Lobster', amount: 10, date: today(), splitByShares: [{ memberId: 'x', shares: 1.5 }] },
    ],
  ])('refuses a body with %s at once with 400', async (_, body) => {
    const { alice, groupId } = await threeMembers();
    const { status } = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body,
      token: alice.token,
    });
    expect(status).toBe(400);
  });

  it('edits an equal expense into an exact one: its kind, its shares and its version change', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const id = await recorded(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [alice.id, bob.id, carol.id],
    });
    const { answer, done } = await edit(alice.token, id, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitExactly: [
        { memberId: alice.id, amount: 200 },
        { memberId: bob.id, amount: 800 },
      ],
      version: 1,
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS' });

    const { body } = await http.get(`${api}/expenses/${id}`, { token: bob.token });
    expect(body).toMatchObject({
      splitKind: 'exact',
      version: 2,
      shares: [
        { memberId: alice.id, amount: 200 },
        { memberId: bob.id, amount: 800 },
      ],
    });
  });

  it("counts each member's share in the balances, however the expense was split", async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    await exactly(alice.token, groupId, [
      [alice.id, 4],
      [bob.id, 6],
    ]);
    const { done } = await byShares(
      alice.token,
      groupId,
      [
        [bob.id, 2],
        [carol.id, 1],
        [alice.id, 1],
      ],
      300,
    );
    expect(done).toMatchObject({ status: 'SUCCESS' });
    // Alice paid 10 exact (her share 4): she is owed 6, bob owes 6. Then 300 by shares of 2, 1 and 1 (bob 150, carol 75,
    // alice 75): alice is owed 225 more, bob owes 150 and carol 75.
    const balances = await balancesOf(alice.token, groupId);
    expect(balances.get(alice.id)).toBe(231);
    expect(balances.get(bob.id)).toBe(-156);
    expect(balances.get(carol.id)).toBe(-75);
    const total = [...balances.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(0);
  });
});
