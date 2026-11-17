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
  // The server's date, read from an operation it answers, as the statement's spec does: the application has one clock.
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'leave-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `${name.toLowerCase()}-leave-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id. */
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

/** A member asks to leave, and answers the outcome of the request. */
async function leave(groupId: string, member: { token: string }) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: member.token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, member.token);
  return { status: done.status, body: done.body };
}

/** Records an expense as a client does, and answers the outcome of the request. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { id: (done.body as { result?: { id: string } }).result?.id, done: done.body as Body };
}

const today = () => serverToday;

/** A group of three: Alice (its owner), Bob and Dan, who joined in that order. */
async function trio() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const dan = await person('Dan');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  await join(groupId, alice, dan);
  return { alice, bob, dan, groupId };
}

describe('Leaving a group', () => {
  it('refuses the owner, who cannot leave the group they created', async () => {
    const { alice, groupId } = await trio();
    const done = await leave(groupId, alice);
    expect(done.body).toMatchObject({ status: 'ERROR', error: { type: 'OwnerCannotLeave' } });
  });

  it('lets a member with a balance of 0 leave, and the group then does not exist for them', async () => {
    const { alice, bob, dan, groupId } = await trio();
    // Dan pays for himself alone: his balance is 0, and the expense concerns him.
    await record(dan.token, groupId, { description: 'Dan', amount: 100, date: today(), splitBetween: [dan.id] });
    const done = await leave(groupId, dan);
    expect(done.body).toMatchObject({ status: 'SUCCESS' });

    expect((await http.get(`${api}/groups/${groupId}`, { token: dan.token })).status).toBe(404);
    const mine = await http.get(`${api}/groups/mine`, { token: dan.token });
    expect((mine.body as { id: string }[]).some(group => group.id === groupId)).toBe(false);
    const members = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect((members.body as { memberId: string }[]).map(member => member.memberId)).toEqual([alice.id, bob.id]);
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect((balances.body as { memberId: string }[]).map(balance => balance.memberId)).toEqual([alice.id, bob.id]);
  });

  it('lets a member leave with a balance that is not 0, and refuses a member who is not in the group', async () => {
    const { alice, bob, groupId } = await trio();
    // Bob pays 100 for himself and Alice: Bob is owed 50, and Alice owes 50.
    await record(bob.token, groupId, {
      description: 'Taxi',
      amount: 100,
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    expect((await leave(groupId, bob)).body).toMatchObject({ status: 'SUCCESS' });
    // What Bob was owed passed to Alice, the owner: Alice's balance is what it was less 50, and Bob's is gone with him.
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect(balances.body).toEqual([
      { memberId: alice.id, balance: 0 },
      { memberId: expect.any(String), balance: 0 },
    ]);
    const stranger = await person('Eve');
    expect((await leave(groupId, stranger)).body).toMatchObject({ status: 'ERROR' });
  });

  it('keeps a former member out of a new split, and out of the payers', async () => {
    const { alice, dan, groupId } = await trio();
    await leave(groupId, dan);
    const split = await record(alice.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: today(),
      splitBetween: [alice.id, dan.id],
    });
    expect(split.done).toMatchObject({ status: 'ERROR', error: { type: 'NotAGroupMember' } });
  });

  it('keeps an expense that concerns a former member from being changed or deleted', async () => {
    const { alice, dan, groupId } = await trio();
    const { id: expenseId } = await record(dan.token, groupId, {
      description: 'Dan alone',
      amount: 100,
      date: today(),
      splitBetween: [dan.id],
    });
    expect(expenseId).toBeTruthy();
    expect((await leave(groupId, dan)).body).toMatchObject({ status: 'SUCCESS' });

    const deleted = await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: alice.token });
    const deletedDone = await outcome((deleted.body as Body).operationId as string, alice.token);
    expect(deletedDone.body).toMatchObject({ status: 'ERROR', error: { type: 'FormerMemberInExpense' } });

    // The owner may edit any expense of the group; Dan, who left, no longer sees it at all.
    const edited = await http.request('PUT', `${api}/expenses/${expenseId}`, {
      body: { description: 'Dan alone', amount: 100, date: today(), splitBetween: [dan.id], version: 1 },
      token: alice.token,
    });
    const editedDone = await outcome((edited.body as Body).operationId as string, alice.token);
    expect(editedDone.body).toMatchObject({ status: 'ERROR', error: { type: 'FormerMemberInExpense' } });

    // The statement of a former member is still read by the members of the group.
    const statement = await http.get(`${api}/groups/${groupId}/members/${dan.id}/statement`, { token: alice.token });
    expect(statement.status).toBe(200);
    expect(statement.body).toMatchObject({ memberId: dan.id, balance: 0 });
  });

  it('lets someone who left join again, last, with a balance of 0', async () => {
    const { alice, bob, dan, groupId } = await trio();
    await leave(groupId, dan);
    await join(groupId, alice, dan);
    const members = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect((members.body as { memberId: string; role: string }[]).map(member => member.memberId)).toEqual([
      alice.id,
      bob.id,
      dan.id,
    ]);
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect((balances.body as { memberId: string; balance: number }[]).find(b => b.memberId === dan.id)).toEqual({
      memberId: dan.id,
      balance: 0,
    });
  });
});

describe('Groups → Ledger → Groups: a member leaves on the balance Ledger has for it, which passes to the owner (MemberBalances)', () => {
  it('asks Ledger the balance, and the balance passes to the owner in the same step', async () => {
    const { alice, bob, dan, groupId } = await trio();
    // Alice pays 600 for Bob and Dan: each owes 300, and Alice is owed 600.
    await record(alice.token, groupId, {
      description: 'Hotel',
      amount: 600,
      date: today(),
      splitExactly: [
        { memberId: alice.id, amount: 0 },
        { memberId: bob.id, amount: 300 },
        { memberId: dan.id, amount: 300 },
      ],
    });
    expect((await leave(groupId, bob)).body).toMatchObject({ status: 'SUCCESS' });

    // Alice 300, Dan -300: the balances still add up to 0, and Bob is in no list of the group.
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect(balances.body).toEqual([
      { memberId: alice.id, balance: 300 },
      { memberId: dan.id, balance: -300 },
    ]);
  });

  it('keeps what passed when the member who left joins again, which starts at 0', async () => {
    const { alice, bob, dan, groupId } = await trio();
    await record(alice.token, groupId, {
      description: 'Hotel',
      amount: 600,
      date: today(),
      splitExactly: [
        { memberId: alice.id, amount: 0 },
        { memberId: bob.id, amount: 300 },
        { memberId: dan.id, amount: 300 },
      ],
    });
    await leave(groupId, bob);
    await join(groupId, alice, bob);
    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect(balances.body).toEqual([
      { memberId: alice.id, balance: 300 },
      { memberId: dan.id, balance: -300 },
      { memberId: bob.id, balance: 0 },
    ]);
  });
});
