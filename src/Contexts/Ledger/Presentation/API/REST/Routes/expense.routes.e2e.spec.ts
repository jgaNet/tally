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
      shares: [
        { memberId: bob.id, amount: 333 },
        { memberId: carol.id, amount: 333 },
        { memberId: alice.id, amount: 334 },
      ],
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
