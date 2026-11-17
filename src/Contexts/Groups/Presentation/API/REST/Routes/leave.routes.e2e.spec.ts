import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Expense = { id: string; paidBy: string; version: number };
type Member = { memberId: string; name: string; role: string; joinedAt: string };
type Balance = { memberId: string; balance: number };
type Statement = { memberId: string; balance: number; entries: { expenseId: string; balance: number }[] };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name = 'Alice'): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Creates an invitation to a group and follows its operation: the result is the invitation's id, the link. */
async function invitation(token: string, groupId: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Accepts an invitation and follows its operation. */
async function accept(token: string, invitationId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Leaves a group and follows its operation: SUCCESS with nothing, or ERROR with the refusal. */
async function leave(token: string, groupId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Records an expense split equally between the members given, and follows its operation: the result is its id. */
async function recordSplitBetween(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; members: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: body.description, amount: body.amount, date: body.date, splitBetween: body.members },
  });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Edits an expense equally between the members given, from the version given, and follows its operation. */
async function editSplitBetween(
  token: string,
  expenseId: string,
  body: { description: string; amount: number; date: string; members: string[]; version: number },
): Promise<Operation> {
  const answer = await http.request('PUT', `${api}/expenses/${expenseId}`, {
    token,
    body: {
      description: body.description,
      amount: body.amount,
      date: body.date,
      splitBetween: body.members,
      version: body.version,
    },
  });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Deletes an expense and follows its operation. */
async function remove(token: string, expenseId: string): Promise<Operation> {
  const answer = await http.request('DELETE', `${api}/expenses/${expenseId}`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** The expense as its group's member reads it: its version is what an edit is made from. */
async function readExpense(token: string, expenseId: string): Promise<Expense> {
  return (await http.get(`${api}/expenses/${expenseId}`, { token })).body as Expense;
}

/** The balances of a group, as a member reads them. */
async function balances(token: string, groupId: string): Promise<Balance[]> {
  return (await http.get(`${api}/groups/${groupId}/balances`, { token })).body as Balance[];
}

const PAST_DAY = '2026-03-10';

/**
 * A group of Alice, its owner, with Bob and Carl in it, in that order. Bob has paid 100 for himself alone, so his balance is
 * 0 and he may leave; Carl is owed nothing either.
 */
async function groupWithEvenBob(suffix: string) {
  const alice = await signedIn(`alice.${suffix}@example.com`, 'Alice');
  const bob = await signedIn(`bob.${suffix}@example.com`, 'Bob');
  const carl = await signedIn(`carl.${suffix}@example.com`, 'Carl');
  const groupId = await createGroup(alice.token, `Trip ${suffix}`);
  const link = await invitation(alice.token, groupId);
  await accept(bob.token, link);
  await accept(carl.token, link);
  const taxi = await recordSplitBetween(bob.token, groupId, {
    description: 'Taxi',
    amount: 100,
    date: PAST_DAY,
    members: [bob.id],
  });
  return { alice, bob, carl, groupId, link, taxi: taxi.result as string };
}

describe('leaving a group', () => {
  it('refuses the owner to leave the group they created, and a stranger, on their operations', async () => {
    const { alice, groupId } = await groupWithEvenBob('own');
    const stranger = await signedIn('stranger.own@example.com', 'Stranger');

    expect(await leave(alice.token, groupId)).toMatchObject({
      status: 'ERROR',
      error: { type: 'OwnerCannotLeave', message: expect.any(String) },
    });
    expect(await leave(stranger.token, groupId)).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('lets a member leave whatever their balance, and the balance passes to the owner in the same step', async () => {
    const alice = await signedIn('alice.owed@example.com', 'Alice');
    const bob = await signedIn('bob.owed@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Dinner');
    await accept(bob.token, await invitation(alice.token, groupId));
    await recordSplitBetween(alice.token, groupId, {
      description: 'Dinner',
      amount: 100,
      date: PAST_DAY,
      members: [alice.id, bob.id],
    });

    expect(await leave(bob.token, groupId)).toMatchObject({ status: 'SUCCESS' });
    expect((await http.get(`${api}/groups/${groupId}`, { token: bob.token })).status).toBe(404);
    // Alice was owed 50; Bob owed 50 and left with it, so what is left of the balances is Alice's, at 0, and they add up to 0.
    expect(await balances(alice.token, groupId)).toEqual([{ memberId: alice.id, balance: 0 }]);
  });

  it('takes an even member out of the group: it is no longer among its members, its balances, or their groups', async () => {
    const { alice, bob, carl, groupId } = await groupWithEvenBob('out');

    expect(await leave(bob.token, groupId)).toMatchObject({ status: 'SUCCESS' });

    expect((await http.get(`${api}/groups/${groupId}`, { token: bob.token })).status).toBe(404);
    expect((await http.get(`${api}/groups/${groupId}/members`, { token: bob.token })).status).toBe(404);
    expect((await http.get(`${api}/groups/${groupId}/expenses`, { token: bob.token })).status).toBe(404);
    const mine = (await http.get(`${api}/groups/mine`, { token: bob.token })).body as { id: string }[];
    expect(mine.map(group => group.id)).not.toContain(groupId);

    const members = (await http.get(`${api}/groups/${groupId}/members`, { token: alice.token })).body as Member[];
    expect(members.map(member => member.memberId)).toEqual([alice.id, carl.id]);
    const left = await balances(alice.token, groupId);
    expect(left.map(row => row.memberId)).not.toContain(bob.id);
    expect(left.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });

  it('cannot be put in the split of a new expense, nor pay one, once it has left', async () => {
    const { alice, bob, groupId } = await groupWithEvenBob('split');
    await leave(bob.token, groupId);

    expect(
      await recordSplitBetween(alice.token, groupId, {
        description: 'Coffee',
        amount: 10,
        date: PAST_DAY,
        members: [alice.id, bob.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'NotAMemberOfTheGroup' } });
    expect(
      await recordSplitBetween(bob.token, groupId, {
        description: 'Tea',
        amount: 5,
        date: PAST_DAY,
        members: [bob.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('keeps the statement of a former member readable by the group, and not by them', async () => {
    const { alice, bob, groupId } = await groupWithEvenBob('statement');
    await leave(bob.token, groupId);

    const statement = await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement`, { token: alice.token });
    expect(statement.status).toBe(200);
    expect(statement.body as Statement).toMatchObject({
      memberId: bob.id,
      balance: 0,
      entries: [{ description: 'Taxi', paid: 100, share: 100, balance: 0 }],
    });
    expect((await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement`, { token: bob.token })).status).toBe(
      404,
    );
  });

  it('refuses to change or delete an expense that concerns a member who has left, by its payer or the owner', async () => {
    const { alice, bob, groupId, taxi } = await groupWithEvenBob('frozen');
    // Bob's balance is 0 once Alice has split a lunch with him, which Bob's Taxi, split with Alice and Bob, balances out.
    const lunch = (
      await recordSplitBetween(alice.token, groupId, {
        description: 'Lunch',
        amount: 100,
        date: PAST_DAY,
        members: [alice.id, bob.id],
      })
    ).result as string;
    const taxiWithAlice = await editSplitBetween(bob.token, taxi, {
      description: 'Taxi',
      amount: 100,
      date: PAST_DAY,
      members: [alice.id, bob.id],
      version: (await readExpense(bob.token, taxi)).version,
    });
    expect(taxiWithAlice).toMatchObject({ status: 'SUCCESS' });

    expect(await leave(bob.token, groupId)).toMatchObject({ status: 'SUCCESS' });

    const taxiNow = await readExpense(alice.token, taxi);
    expect(
      await editSplitBetween(alice.token, taxi, {
        description: 'Taxi, again',
        amount: 100,
        date: PAST_DAY,
        members: [alice.id],
        version: taxiNow.version,
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'ExpenseConcernsAFormerMember' } });
    expect(await remove(alice.token, taxi)).toMatchObject({
      status: 'ERROR',
      error: { type: 'ExpenseConcernsAFormerMember' },
    });
    expect(await remove(alice.token, lunch)).toMatchObject({
      status: 'ERROR',
      error: { type: 'ExpenseConcernsAFormerMember' },
    });

    const left = await balances(alice.token, groupId);
    expect(left.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    expect(left.map(row => row.memberId)).not.toContain(bob.id);
  });

  it('lets a former member join again, last, at 0, and makes their expenses changeable again', async () => {
    const { alice, bob, carl, groupId, link } = await groupWithEvenBob('again');
    await leave(bob.token, groupId);

    expect(await accept(bob.token, link)).toMatchObject({ status: 'SUCCESS' });

    const members = (await http.get(`${api}/groups/${groupId}/members`, { token: alice.token })).body as Member[];
    // Bob is last: he joined again after Carl, who never left.
    expect(members.map(member => [member.memberId, member.role])).toEqual([
      [alice.id, 'owner'],
      [carl.id, 'member'],
      [bob.id, 'member'],
    ]);
    expect((await http.get(`${api}/groups/${groupId}`, { token: bob.token })).status).toBe(200);
    expect(await balances(alice.token, groupId)).toEqual(expect.arrayContaining([{ memberId: bob.id, balance: 0 }]));
  });

  it('answers 401 to a caller who is not signed in', async () => {
    const { groupId } = await groupWithEvenBob('anon');

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`)).status).toBe(401);
  });
});

describe('Groups → Ledger (GroupMembers)', () => {
  it('splits an expense in a group made in Groups by the id its creation answered, with a member who has just joined, and finds it there by that id', async () => {
    const alice = await signedIn('alice.members@example.com', 'Alice');
    const bob = await signedIn('bob.members@example.com', 'Bob');
    // Groups answers the group's id: the expense is recorded in Ledger under that id, its split read from Groups' members.
    const groupId = await createGroup(alice.token, 'Members');
    await accept(bob.token, await invitation(alice.token, groupId));

    const recorded = await recordSplitBetween(bob.token, groupId, {
      description: 'Bread',
      amount: 40,
      date: PAST_DAY,
      members: [alice.id, bob.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const expenseId = recorded.result as string;

    const listed = (await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token })).body as Expense[];
    expect(listed.map(expense => expense.id)).toContain(expenseId);
    expect(await balances(alice.token, groupId)).toEqual(expect.arrayContaining([{ memberId: bob.id, balance: 20 }]));
  });
});

describe('Ledger → Groups (MemberBalances)', () => {
  it("lets a member leave a group whose balance Ledger keeps for them, and reads the owner's balance with it by the group id Groups answered", async () => {
    const alice = await signedIn('alice.balances@example.com', 'Alice');
    const bob = await signedIn('bob.balances@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Balances');
    await accept(bob.token, await invitation(alice.token, groupId));
    // Ledger records the expense, under the id of the group Groups made: Bob owes 50 of it.
    const recorded = await recordSplitBetween(alice.token, groupId, {
      description: 'Dinner',
      amount: 100,
      date: PAST_DAY,
      members: [alice.id, bob.id],
    });
    const expenseId = recorded.result as string;

    expect(await balances(alice.token, groupId)).toEqual(expect.arrayContaining([{ memberId: alice.id, balance: 50 }]));
    expect(await leave(bob.token, groupId)).toMatchObject({ status: 'SUCCESS' });
    expect(await balances(alice.token, groupId)).toEqual([{ memberId: alice.id, balance: 0 }]);
    expect((await readExpense(alice.token, expenseId)).id).toBe(expenseId);
  });
});
