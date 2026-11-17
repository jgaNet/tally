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
    body: { email: 'history-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `${name.toLowerCase()}-history-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense as a client does, and answers its id. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result: { id: string } }).result.id;
}

const daysFromToday = (days: number) =>
  new Date(new Date(`${serverToday}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

type Expense = { id: string; date: string; description: string; amount: number; version: number };

/** A group of four: Alice (its owner), Bob, Carol and Dan, who joined in that order, and Eve, who never joins. */
async function fourMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const carol = await person('Carol');
  const dan = await person('Dan');
  const eve = await person('Eve');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  await join(groupId, alice, carol);
  await join(groupId, alice, dan);
  return { alice, bob, carol, dan, eve, groupId };
}

/**
 * Four expenses, recorded in this order:
 *  A, 2 days ago, paid by Alice, split between Alice and Bob (900: 450 each);
 *  B, 5 days ago, paid by Bob, split between Alice, Bob and Carol (600: 200 each);
 *  C, 2 days ago, paid by Carol, split on Carol alone (300);
 *  D, 5 days ago, paid by Alice, split on Alice alone (100).
 */
async function scenario() {
  const people = await fourMembers();
  const { alice, bob, carol, groupId } = people;
  const a = await record(alice.token, groupId, {
    description: 'A',
    amount: 900,
    date: daysFromToday(-2),
    splitBetween: [alice.id, bob.id],
  });
  const b = await record(bob.token, groupId, {
    description: 'B',
    amount: 600,
    date: daysFromToday(-5),
    splitBetween: [alice.id, bob.id, carol.id],
  });
  const c = await record(carol.token, groupId, {
    description: 'C',
    amount: 300,
    date: daysFromToday(-2),
    splitBetween: [carol.id],
  });
  const d = await record(alice.token, groupId, {
    description: 'D',
    amount: 100,
    date: daysFromToday(-5),
    splitBetween: [alice.id],
  });
  return { ...people, a, b, c, d };
}

async function statement(groupId: string, memberId: string, token: string) {
  return http.get(`${api}/groups/${groupId}/members/${memberId}/statement`, { token });
}

describe("a group's expenses", () => {
  it('lists them the latest date first, then the most recently recorded first; an edit does not move one', async () => {
    const { alice, groupId, a, b, c, d } = await scenario();

    const before = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect(before.status).toBe(200);
    expect((before.body as Expense[]).map(expense => expense.id)).toEqual([c, a, d, b]);

    // A is edited: it keeps the place it was recorded in, so it is still after C, which was recorded later.
    const read = (await http.get(`${api}/expenses/${a}`, { token: alice.token })).body as Expense;
    const edit = await http.request('PUT', `${api}/expenses/${a}`, {
      body: {
        description: 'A, edited',
        amount: 900,
        date: daysFromToday(-2),
        splitBetween: [alice.id],
        version: read.version,
      },
      token: alice.token,
    });
    expect(edit.status).toBe(202);
    await outcome((edit.body as Body).operationId as string, alice.token);

    const after = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect((after.body as Expense[]).map(expense => expense.id)).toEqual([c, a, d, b]);
    expect((after.body as Expense[])[1]).toMatchObject({ id: a, description: 'A, edited', version: 2 });
  });

  it('lists each expense as the expense itself reads it, and leaves out a deleted one', async () => {
    const { alice, groupId, d } = await scenario();
    const deleted = await http.request('DELETE', `${api}/expenses/${d}`, { token: alice.token });
    expect(deleted.status).toBe(202);
    await outcome((deleted.body as Body).operationId as string, alice.token);

    const { status, body } = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect(status).toBe(200);
    const listed = body as Expense[];
    expect(listed.some(expense => expense.id === d)).toBe(false);
    for (const expense of listed) {
      const single = await http.get(`${api}/expenses/${expense.id}`, { token: alice.token });
      expect(expense).toEqual(single.body);
    }
  });

  it('answers the group does not exist to a signed-in account that is not a member, and 401 to no one', async () => {
    const { groupId, eve } = await scenario();
    const outsider = await http.get(`${api}/groups/${groupId}/expenses`, { token: eve.token });
    expect(outsider.status).toBe(404);
    const anonymous = await http.get(`${api}/groups/${groupId}/expenses`);
    expect(anonymous.status).toBe(401);
  });
});

describe("a member's statement", () => {
  it('lists the expenses the member paid or is in the split of, the earliest date first, with the running balance', async () => {
    const { bob, carol, groupId, b, a } = await scenario();
    const { status, body } = await statement(groupId, bob.id, bob.token);
    expect(status).toBe(200);
    // Bob: B (5 days ago) paid 600 of 200 share, then A (2 days ago) share 450. C does not concern him.
    expect(body).toEqual({
      memberId: bob.id,
      balance: -50,
      entries: [
        { expenseId: b, date: daysFromToday(-5), description: 'B', paid: 600, share: 200, balance: 400 },
        { expenseId: a, date: daysFromToday(-2), description: 'A', paid: 0, share: 450, balance: -50 },
      ],
    });

    // Carol reads Bob's statement, a member reading another member's.
    const read = await statement(groupId, bob.id, carol.token);
    expect(read.status).toBe(200);
  });

  it('orders the same date by the earliest recorded first, and its balance is the one the group gives', async () => {
    const { alice, groupId, b, d, a } = await scenario();
    const { status, body } = await statement(groupId, alice.id, alice.token);
    expect(status).toBe(200);
    const statementBody = body as { balance: number; entries: { expenseId: string; balance: number }[] };
    // B and D are both 5 days ago: B was recorded first. Alice's share of B is 200; D is hers alone.
    expect(statementBody.entries.map(entry => entry.expenseId)).toEqual([b, d, a]);
    expect(statementBody.entries.map(entry => entry.balance)).toEqual([-200, -200, 250]);
    expect(statementBody.balance).toBe(250);

    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    const aliceBalance = (balances.body as { memberId: string; balance: number }[]).find(
      each => each.memberId === alice.id,
    );
    expect(aliceBalance?.balance).toBe(statementBody.balance);
  });

  it('leaves out a deleted expense, and gives 0 and no entries to a member with nothing in the group', async () => {
    const { alice, dan, groupId, d } = await scenario();
    const deleted = await http.request('DELETE', `${api}/expenses/${d}`, { token: alice.token });
    await outcome((deleted.body as Body).operationId as string, alice.token);

    const aliceAfter = await statement(groupId, alice.id, alice.token);
    expect(
      (aliceAfter.body as { entries: { expenseId: string }[] }).entries.map(entry => entry.expenseId),
    ).not.toContain(d);

    const nothing = await statement(groupId, dan.id, dan.token);
    expect(nothing.status).toBe(200);
    expect(nothing.body).toEqual({ memberId: dan.id, balance: 0, entries: [] });
  });

  it('does not exist for someone who has never been a member, nor for a caller who is not one', async () => {
    const { alice, eve, groupId } = await scenario();
    const notAMember = await statement(groupId, eve.id, alice.token);
    expect(notAMember.status).toBe(404);

    const outsider = await statement(groupId, alice.id, eve.token);
    expect(outsider.status).toBe(404);

    const anonymous = await http.get(`${api}/groups/${groupId}/members/${alice.id}/statement`);
    expect(anonymous.status).toBe(401);
  });
});

describe('Groups → Ledger: a group made through the API is read by Ledger by the id that request answered', () => {
  it('lists the group expenses and the statement of its owner by the id the group was answered with', async () => {
    const owner = await person('Owner');
    const groupId = await createGroup(owner);

    const listed = await http.get(`${api}/groups/${groupId}/expenses`, { token: owner.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);

    const own = await statement(groupId, owner.id, owner.token);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ memberId: owner.id, balance: 0, entries: [] });

    const expenseId = await record(owner.token, groupId, {
      description: 'Coffee',
      amount: 300,
      date: serverToday,
      splitBetween: [owner.id],
    });
    const afterRecord = await http.get(`${api}/groups/${groupId}/expenses`, { token: owner.token });
    expect((afterRecord.body as Expense[]).map(expense => expense.id)).toEqual([expenseId]);
  });
});
