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
type Expense = {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  splitKind: 'equal' | 'exact' | 'shares';
  version: number;
  category?: string;
  shares: { memberId: string; amount: number }[];
  original?: { currency: string; amount: number; rate: string };
};

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

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** One of the three ways to split, as a body gives it: equally, by exact amounts, or by shares. */
type SplitFields =
  | { splitBetween: string[] }
  | { splitExactly: { memberId: string; amount: number }[] }
  | { splitByShares: { memberId: string; shares: number }[] };
/** The money of an expense as a body gives it: its amount in the group's currency, or what was paid in another (request 21). */
type MoneyFields = { amount: number } | { original: { currency: string; amount: number; rate: string } };
type ExpenseFields = { description: string; date: string } & MoneyFields & SplitFields;

/** Records an expense, and follows its operation: the operation's answer, SUCCESS with the id or ERROR with the refusal. */
async function record(token: string, groupId: string, body: ExpenseFields): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Edits an expense from the version given, and follows its operation the same way as recording one. */
async function edit(token: string, expenseId: string, body: ExpenseFields & { version: number }): Promise<Operation> {
  const answer = await http.request('PUT', `${api}/expenses/${expenseId}`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** A day long past, which every expense may be spent on; the far future is after any today. */
const PAST_DAY = '2026-03-10';
const FUTURE_DAY = '9999-12-31';

describe('expenses', () => {
  it('splits an amount equally, the remainder to the first member listed, and lets a member read it in the split order', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const bob = await signedIn('bea@example.com', 'Bob');
    const carl = await signedIn('cai@example.com', 'Carl');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);
    await join(alice.token, groupId, carl.token);

    const recorded = await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [bob.id, alice.id, carl.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: recorded.result as string,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      paidBy: alice.id,
      splitKind: 'equal',
      version: 1,
      category: 'other',
      shares: [
        { memberId: bob.id, amount: 334 },
        { memberId: alice.id, amount: 333 },
        { memberId: carl.id, amount: 333 },
      ],
    } satisfies Expense & { version: number });
  });

  it('splits an expense by exact amounts, or by shares, and says which way it was split', async () => {
    const alice = await signedIn('una@example.com', 'Alice');
    const bob = await signedIn('vic@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Holiday');
    await join(alice.token, groupId, bob.token);

    const exact = await record(alice.token, groupId, {
      description: 'Lobster',
      amount: 4000,
      date: PAST_DAY,
      splitExactly: [
        { memberId: alice.id, amount: 1000 },
        { memberId: bob.id, amount: 3000 },
      ],
    });
    expect(exact).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const exactRead = await http.get(`${api}/expenses/${exact.result}`, { token: bob.token });
    expect(exactRead.body).toMatchObject({
      splitKind: 'exact',
      paidBy: alice.id,
      shares: [
        { memberId: alice.id, amount: 1000 },
        { memberId: bob.id, amount: 3000 },
      ],
    });

    // Bob pays: 1001 by shares of 2 (Alice) and 1 (Bob), the payer listed second, is 668 for Alice (the remainder, as the
    // first listed) and 333 for Bob.
    const shared = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: {
        description: 'Cottage',
        amount: 1001,
        date: PAST_DAY,
        splitByShares: [
          { memberId: alice.id, shares: 2 },
          { memberId: bob.id, shares: 1 },
        ],
      },
    });
    const sharedOperation = await outcome((shared.body as { operationId: string }).operationId, bob.token);
    expect(sharedOperation).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const sharedRead = await http.get(`${api}/expenses/${sharedOperation.result}`, { token: alice.token });
    expect(sharedRead.body).toMatchObject({
      splitKind: 'shares',
      paidBy: bob.id,
      shares: [
        { memberId: alice.id, amount: 668 },
        { memberId: bob.id, amount: 333 },
      ],
    });
  });

  it('refuses a split by exact amounts that does not add up, or a share below 1, on its operation', async () => {
    const alice = await signedIn('wes@example.com', 'Alice');
    const bob = await signedIn('xan@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);

    const short = await record(alice.token, groupId, {
      description: 'Rent part',
      amount: 1000,
      date: PAST_DAY,
      splitExactly: [
        { memberId: alice.id, amount: 400 },
        { memberId: bob.id, amount: 500 },
      ],
    });
    const noShare = await record(alice.token, groupId, {
      description: 'Rent part',
      amount: 1000,
      date: PAST_DAY,
      splitByShares: [
        { memberId: alice.id, shares: 1 },
        { memberId: bob.id, shares: 0 },
      ],
    });

    expect(short).toMatchObject({
      status: 'ERROR',
      error: { type: 'ShareAmountsDoNotAddUp', message: expect.any(String) },
    });
    expect(noShare).toMatchObject({
      status: 'ERROR',
      error: { type: 'InvalidShareCount', message: expect.any(String) },
    });
  });

  it('answers 400 to a body that gives none of the three ways to split, or more than one', async () => {
    const alice = await signedIn('yan@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const fields = { description: 'Milk', amount: 100, date: PAST_DAY };

    const none = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token: alice.token, body: fields });
    const two = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: {
        ...fields,
        splitBetween: [alice.id],
        splitByShares: [{ memberId: alice.id, shares: 1 }],
      },
    });

    expect(none.status).toBe(400);
    expect(two.status).toBe(400);
  });

  it('is edited into another way of splitting, from the version its author read', async () => {
    const alice = await signedIn('zoe@example.com', 'Alice');
    const bob = await signedIn('abe@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Trip');
    await join(alice.token, groupId, bob.token);
    const recorded = await record(alice.token, groupId, {
      description: 'Fuel',
      amount: 900,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });

    const edited = await edit(alice.token, recorded.result as string, {
      description: 'Fuel',
      amount: 900,
      date: PAST_DAY,
      version: 1,
      splitByShares: [
        { memberId: alice.id, shares: 2 },
        { memberId: bob.id, shares: 1 },
      ],
    });
    expect(edited).toMatchObject({ status: 'SUCCESS' });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.body).toMatchObject({
      splitKind: 'shares',
      version: 2,
      shares: [
        { memberId: alice.id, amount: 600 },
        { memberId: bob.id, amount: 300 },
      ],
    });
  });

  it('hides an expense from anyone who is not a member of its group, as if it did not exist', async () => {
    const alice = await signedIn('ivo@example.com', 'Alice');
    const stranger = await signedIn('jan@example.com', 'Jan');
    const groupId = await createGroup(alice.token, 'Board games');
    const recorded = await record(alice.token, groupId, {
      description: 'Dice',
      amount: 500,
      date: PAST_DAY,
      splitBetween: [alice.id],
    });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: stranger.token });

    expect(read.status).toBe(404);
  });

  it('answers 404 for an expense that is not there, and 401 to a caller who is not signed in', async () => {
    const alice = await signedIn('kim@example.com', 'Alice');

    expect((await http.get(`${api}/expenses/nope`, { token: alice.token })).status).toBe(404);
    expect((await http.get(`${api}/expenses/nope`)).status).toBe(401);
  });

  it('refuses a member who is not signed in before anything is recorded', async () => {
    const alice = await signedIn('lu@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Choir');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Music', amount: 100, date: PAST_DAY, splitBetween: [alice.id] },
    });

    expect(answer.status).toBe(401);
  });

  it('refuses a stranger recording into a group they are not in, as if the group did not exist', async () => {
    const alice = await signedIn('mo@example.com', 'Alice');
    const stranger = await signedIn('ned@example.com', 'Ned');
    const groupId = await createGroup(alice.token, 'Club');

    const recorded = await record(stranger.token, groupId, {
      description: 'Tickets',
      amount: 100,
      date: PAST_DAY,
      splitBetween: [stranger.id],
    });

    expect(recorded).toMatchObject({ status: 'ERROR', error: { type: 'NotFound', message: expect.any(String) } });
  });

  it('refuses a split that breaks the rules, on its operation, each by the rule it breaks', async () => {
    const alice = await signedIn('oli@example.com', 'Alice');
    const bob = await signedIn('pia@example.com', 'Bob');
    const stranger = await signedIn('quin@example.com', 'Quin');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);
    const valid = { description: 'Rent part', amount: 100, date: PAST_DAY, splitBetween: [alice.id, bob.id] };

    const cases: [string, Partial<typeof valid>, string][] = [
      ['InvalidDescription', { description: '   ' }, 'blank description'],
      ['InvalidDescription', { description: 'x'.repeat(101) }, 'description over 100'],
      ['InvalidAmount', { amount: 0 }, 'amount of 0'],
      ['InvalidAmount', { amount: 100_000_001 }, 'amount over 100 000 000'],
      ['InvalidDate', { date: '2026-02-30' }, 'a day not in the calendar'],
      ['DateInTheFuture', { date: FUTURE_DAY }, 'a day after today'],
      ['DuplicateSplitMember', { splitBetween: [alice.id, alice.id] }, 'a member listed twice'],
      ['PayerNotInSplit', { splitBetween: [bob.id] }, 'a split without the payer'],
      ['NotAMemberOfTheGroup', { splitBetween: [alice.id, stranger.id] }, 'a split with a stranger'],
    ];
    for (const [type, change] of cases) {
      const refused = await record(alice.token, groupId, { ...valid, ...change });
      expect(refused).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
    }
  });

  it('answers 400 to a body of the wrong shape, before the expense decides anything', async () => {
    const alice = await signedIn('rae@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: { description: 'Milk', amount: 'two', date: PAST_DAY, splitBetween: [alice.id] },
    });

    expect(answer.status).toBe(400);
  });
});

describe('Groups → Ledger', () => {
  it('splits an expense with a member who has just joined Groups, and finds it by the id it answered', async () => {
    const alice = await signedIn('ros@example.com', 'Alice');
    const bob = await signedIn('sam@example.com', 'Bob');
    // Groups makes the group and answers its id; a join is a fact Ledger reads at the moment it decides.
    const groupId = await createGroup(alice.token, 'Just joined');
    await join(alice.token, groupId, bob.token);

    const recorded = await record(alice.token, groupId, {
      description: 'Snacks',
      amount: 101,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.body).toMatchObject({
      id: recorded.result,
      groupId,
      shares: [
        { memberId: alice.id, amount: 51 },
        { memberId: bob.id, amount: 50 },
      ],
    });
  });
});

describe('editing and deleting an expense', () => {
  /** A group of two, Alice its owner and Bob a member, with one expense of Alice's, 1000 split equally. */
  async function withExpense(suffix: string) {
    const alice = await signedIn(`alice-${suffix}@example.com`, 'Alice');
    const bob = await signedIn(`bob-${suffix}@example.com`, 'Bob');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);
    const recorded = await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    return { alice, bob, groupId, expenseId: recorded.result as string };
  }

  const edit = (token: string, expenseId: string, body: Record<string, unknown>) =>
    http
      .request('PUT', `${api}/expenses/${expenseId}`, { token, body })
      .then(async answer =>
        answer.status !== 202
          ? ({ status: `HTTP ${answer.status}` } as Operation)
          : outcome((answer.body as { operationId: string }).operationId, token),
      );

  const remove = (token: string, expenseId: string) =>
    http
      .request('DELETE', `${api}/expenses/${expenseId}`, { token })
      .then(async answer =>
        answer.status !== 202
          ? ({ status: `HTTP ${answer.status}` } as Operation)
          : outcome((answer.body as { operationId: string }).operationId, token),
      );

  const read = (token: string, expenseId: string) => http.get(`${api}/expenses/${expenseId}`, { token });
  const balances = async (token: string, groupId: string) =>
    (await http.get(`${api}/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];

  it('answers the expense with its version: 1 when recorded', async () => {
    const { alice, expenseId } = await withExpense('version');

    const answer = await read(alice.token, expenseId);

    expect(answer.status).toBe(200);
    expect((answer.body as Expense & { version: number }).version).toBe(1);
  });

  it('replaces the expense whole from the version its author read, and its version goes up by one', async () => {
    const { alice, bob, groupId, expenseId } = await withExpense('replace');

    const kept = await edit(alice.token, expenseId, {
      description: 'Groceries, again',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    expect(kept).toMatchObject({ status: 'SUCCESS' });
    const expense = (await read(alice.token, expenseId)).body as Expense & { version: number };
    expect(expense).toMatchObject({
      description: 'Groceries, again',
      amount: 600,
      paidBy: alice.id,
      version: 2,
      shares: [
        { memberId: alice.id, amount: 300 },
        { memberId: bob.id, amount: 300 },
      ],
    });
    expect(await balances(alice.token, groupId)).toEqual(
      expect.arrayContaining([
        { memberId: alice.id, balance: 300 },
        { memberId: bob.id, balance: -300 },
      ]),
    );
  });

  it('refuses an edit made from a version the expense has since left, by name, and keeps nothing of it', async () => {
    const { alice, bob, groupId, expenseId } = await withExpense('stale');
    await edit(alice.token, expenseId, {
      description: 'Groceries',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    const stale = await edit(alice.token, expenseId, {
      description: 'Stale',
      amount: 50,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    expect(stale).toMatchObject({ status: 'ERROR', error: { type: 'ExpenseChanged' } });
    const expense = (await read(alice.token, expenseId)).body as Expense & { version: number };
    expect(expense).toMatchObject({ amount: 600, version: 2 });
    const total = (await balances(alice.token, groupId)).reduce((sum, row) => sum + row.balance, 0);
    expect(total).toBe(0);
  });

  it('lets two edits at once through one of them only: the other is refused, and the balances add up to 0', async () => {
    const { alice, bob, groupId, expenseId } = await withExpense('race');
    const body = (amount: number) => ({
      description: 'Groceries',
      amount,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    const [first, second] = await Promise.all([
      edit(alice.token, expenseId, body(600)),
      edit(alice.token, expenseId, body(800)),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter(op => op.status === 'SUCCESS')).toHaveLength(1);
    expect(outcomes.filter(op => op.status === 'ERROR' && op.error?.type === 'ExpenseChanged')).toHaveLength(1);
    const expense = (await read(alice.token, expenseId)).body as Expense & { version: number };
    expect(expense.version).toBe(2);
    expect([600, 800]).toContain(expense.amount);
    const mine = (await balances(alice.token, groupId)).find(row => row.memberId === alice.id);
    expect(mine?.balance).toBe(expense.amount / 2);
    expect((await balances(alice.token, groupId)).reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });

  it('refuses an edit or a deletion by a member who is neither the payer nor the owner', async () => {
    const { alice, bob, expenseId } = await withExpense('other');

    expect(
      await edit(bob.token, expenseId, {
        description: 'Mine now',
        amount: 10,
        date: PAST_DAY,
        splitBetween: [alice.id, bob.id],
        version: 1,
      }),
    ).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotThePayerOrTheOwner' },
    });
    expect(await remove(bob.token, expenseId)).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotThePayerOrTheOwner' },
    });
  });

  it('lets the owner edit an expense another member paid, and the payer stays the one who paid', async () => {
    const { alice, bob, groupId } = await withExpense('owner-edits');
    const bobPaid = await record(bob.token, groupId, {
      description: 'Taxi',
      amount: 400,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });

    const kept = await edit(alice.token, bobPaid.result as string, {
      description: 'Taxi home',
      amount: 400,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
      version: 1,
    });

    expect(kept).toMatchObject({ status: 'SUCCESS' });
    expect(((await read(alice.token, bobPaid.result as string)).body as Expense).paidBy).toBe(bob.id);
  });

  it('is not there at all for someone outside the group', async () => {
    const { expenseId } = await withExpense('outsider');
    const carl = await signedIn('carl-outsider@example.com', 'Carl');

    expect((await read(carl.token, expenseId)).status).toBe(404);
    expect(
      await edit(carl.token, expenseId, {
        description: 'Carl',
        amount: 10,
        date: PAST_DAY,
        splitBetween: [carl.id],
        version: 1,
      }),
    ).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotFound' },
    });
    expect(await remove(carl.token, expenseId)).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('deletes the expense: it is not read, and it counts in no balance', async () => {
    const { alice, groupId, expenseId } = await withExpense('delete');

    expect(await remove(alice.token, expenseId)).toMatchObject({ status: 'SUCCESS' });

    expect((await read(alice.token, expenseId)).status).toBe(404);
    expect(await balances(alice.token, groupId)).toEqual(expect.arrayContaining([{ memberId: alice.id, balance: 0 }]));
    expect((await balances(alice.token, groupId)).every(row => row.balance === 0)).toBe(true);
    expect(await remove(alice.token, expenseId)).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('refuses an edit or a deletion from a caller who is not signed in, at once, with 401', async () => {
    const { expenseId } = await withExpense('anonymous');

    expect(
      (
        await http.request('PUT', `${api}/expenses/${expenseId}`, {
          body: { description: 'x', amount: 1, date: PAST_DAY, splitBetween: [], version: 1 },
        })
      ).status,
    ).toBe(401);
    expect((await http.request('DELETE', `${api}/expenses/${expenseId}`, {})).status).toBe(401);
  });
});

describe('an expense in another currency', () => {
  it('is converted into the group currency, and keeps what was paid and the rate as they were given', async () => {
    const alice = await signedIn('ola@example.com', 'Alice');
    const bob = await signedIn('ole@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Zurich');
    await join(alice.token, groupId, bob.token);

    // 1234 francs at 1.0625 is 1311.125 euros, so 1311: split equally, the remainder to the first member listed.
    const recorded = await record(alice.token, groupId, {
      description: 'Train tickets',
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.body).toEqual({
      id: recorded.result as string,
      groupId,
      description: 'Train tickets',
      amount: 1311,
      date: PAST_DAY,
      paidBy: alice.id,
      splitKind: 'equal',
      version: 1,
      category: 'other',
      shares: [
        { memberId: alice.id, amount: 656 },
        { memberId: bob.id, amount: 655 },
      ],
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
    });

    const listed = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect(listed.body).toEqual([
      expect.objectContaining({ amount: 1311, original: { currency: 'CHF', amount: 1234, rate: '1.0625' } }),
    ]);

    const balances = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect(balances.body).toEqual([
      { memberId: alice.id, balance: 655 },
      { memberId: bob.id, balance: -655 },
    ]);
  });

  it('keeps a rate written as the payer gave it, and a half is rounded up', async () => {
    const alice = await signedIn('pim@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Trip');
    const recorded = await record(alice.token, groupId, {
      description: 'Coins',
      original: { currency: 'GBP', amount: 1, rate: '0.5' },
      date: PAST_DAY,
      splitBetween: [alice.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: alice.token });
    expect(read.body).toMatchObject({ amount: 1, original: { currency: 'GBP', amount: 1, rate: '0.5' } });
  });

  it('is edited into the group currency, and back into another, from the version its author read', async () => {
    const alice = await signedIn('qua@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Holiday');
    const recorded = await record(alice.token, groupId, {
      description: 'Hotel',
      original: { currency: 'USD', amount: 10000, rate: '0.9542' },
      date: PAST_DAY,
      splitBetween: [alice.id],
    });
    const expenseId = recorded.result as string;

    const inGroupCurrency = await edit(alice.token, expenseId, {
      description: 'Hotel',
      amount: 9542,
      date: PAST_DAY,
      version: 1,
      splitBetween: [alice.id],
    });
    expect(inGroupCurrency).toMatchObject({ status: 'SUCCESS' });
    const afterEdit = await http.get(`${api}/expenses/${expenseId}`, { token: alice.token });
    expect(afterEdit.body).toMatchObject({ amount: 9542, version: 2 });
    expect(afterEdit.body).not.toHaveProperty('original');

    const back = await edit(alice.token, expenseId, {
      description: 'Hotel',
      original: { currency: 'USD', amount: 10000, rate: '0.9542' },
      date: PAST_DAY,
      version: 2,
      splitBetween: [alice.id],
    });
    expect(back).toMatchObject({ status: 'SUCCESS' });
    const again = await http.get(`${api}/expenses/${expenseId}`, { token: alice.token });
    expect(again.body).toMatchObject({
      amount: 9542,
      version: 3,
      original: { currency: 'USD', amount: 10000, rate: '0.9542' },
    });
  });

  it('refuses on its operation a currency that is the group’s own or not Tally’s, a rate that is not valid, and an amount out of range once converted', async () => {
    const alice = await signedIn('rex@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const fields = { description: 'Repair', date: PAST_DAY, splitBetween: [alice.id] };

    const sameCurrency = await record(alice.token, groupId, {
      ...fields,
      original: { currency: 'EUR', amount: 100, rate: '1' },
    });
    const unknownCurrency = await record(alice.token, groupId, {
      ...fields,
      original: { currency: 'JPY', amount: 100, rate: '1' },
    });
    const badRate = await record(alice.token, groupId, {
      ...fields,
      original: { currency: 'USD', amount: 100, rate: '1.0000001' },
    });
    const zeroRate = await record(alice.token, groupId, {
      ...fields,
      original: { currency: 'USD', amount: 100, rate: '0' },
    });
    const overflow = await record(alice.token, groupId, {
      ...fields,
      original: { currency: 'USD', amount: 100_000_000, rate: '2' },
    });

    expect(sameCurrency).toMatchObject({ status: 'ERROR', error: { type: 'SameCurrencyAsTheGroup' } });
    expect(unknownCurrency).toMatchObject({ status: 'ERROR', error: { type: 'InvalidOriginalCurrency' } });
    expect(badRate).toMatchObject({ status: 'ERROR', error: { type: 'InvalidRate' } });
    expect(zeroRate).toMatchObject({ status: 'ERROR', error: { type: 'InvalidRate' } });
    expect(overflow).toMatchObject({ status: 'ERROR', error: { type: 'InvalidAmount' } });
  });

  it('answers 400 to a rate given as a number, and to a body with both an amount and an original, or neither', async () => {
    const alice = await signedIn('tan@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');
    const fields = { description: 'Repair', date: PAST_DAY, splitBetween: [alice.id] };
    const original = { currency: 'USD', amount: 100, rate: '1' };

    const numberRate = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: { ...fields, original: { ...original, rate: 1 } },
    });
    const both = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: { ...fields, amount: 100, original },
    });
    const neither = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: fields,
    });

    expect(numberRate.status).toBe(400);
    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
  });
});
