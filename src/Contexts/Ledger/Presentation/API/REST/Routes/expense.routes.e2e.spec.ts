import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Expenses, end to end: the application booted in this process on a free port, spoken to over HTTP, every answer held
 * to api/4-record-an-expense.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
/** A day long spent, and one no clock will reach: the rule against a day after today is held by the domain. */
const SPENT = '2020-01-02';
const FUTURE = '9999-12-31';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which each of `others` joins by an invitation: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

const record = (groupId: string, token: string | undefined, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token?: string) => http.get(`/v1/expenses/${id}`, { token });
const editExpense = (id: string, token: string | undefined, body: unknown) =>
  http.request('PUT', `/v1/expenses/${id}`, { body, token });
const deleteExpense = (id: string, token?: string) => http.request('DELETE', `/v1/expenses/${id}`, { token });
const balancesOf = (groupId: string, token: string) => http.get(`/v1/groups/${groupId}/balances`, { token });

describe('Groups → Ledger', () => {
  it('splits an expense between members of a group made through the API, and reads it by the id it was answered', async () => {
    const ana = await accountOf('ana.split@example.com', 'Ana');
    const ben = await accountOf('ben.split@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Groceries',
      amount: 1000,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    const read = await readExpense(expenseId, ben.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: expenseId,
      groupId,
      amount: 1000,
      paidBy: ana.id,
      shares: [
        { memberId: ben.id, amount: 500 },
        { memberId: ana.id, amount: 500 },
      ],
    });
  });
});

describe('Groups → Ledger, editing and deleting', () => {
  it('lets the owner, whom Groups names as the owner, edit and delete a member’s expense, and keeps the payer', async () => {
    const ana = await accountOf('ana.owner-edit@example.com', 'Ana');
    const ben = await accountOf('ben.owner-edit@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const recorded = await record(groupId, ben.token, {
      description: 'Tram tickets',
      amount: 600,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
    });
    const expenseId = (recorded.body as { id: string }).id;

    const edited = await editExpense(expenseId, ana.token, {
      description: 'Tram tickets',
      amount: 900,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
      version: 1,
    });
    const read = await readExpense(expenseId, ana.token);
    expect(edited.status).toBe(201);
    expect(read.body).toMatchObject({ amount: 900, paidBy: ben.id, version: 2 });

    const deleted = await deleteExpense(expenseId, ana.token);
    expect(deleted.status).toBe(201);
    expect((await readExpense(expenseId, ana.token)).status).toBe(404);
  });
});

describe('recording an expense', () => {
  it('gives the remainder to the first member listed, whoever paid, so the shares add up to the amount', async () => {
    const ana = await accountOf('ana.remainder@example.com', 'Ana');
    const ben = await accountOf('ben.remainder@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Taxi',
      amount: 1001,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
    });
    const read = await readExpense((recorded.body as { id: string }).id, ana.token);

    expect(read.body).toMatchObject({
      shares: [
        { memberId: ben.id, amount: 501 },
        { memberId: ana.id, amount: 500 },
      ],
    });
  });

  it('refuses a split with someone who is not a member, listed twice, or without the payer', async () => {
    const ana = await accountOf('ana.split-refusals@example.com', 'Ana');
    const ben = await accountOf('ben.split-refusals@example.com', 'Ben');
    const stranger = await accountOf('stranger.split-refusals@example.com', 'Stranger');
    const groupId = await groupWith(ana, [ben]);
    const base = { description: 'Dinner', amount: 900, date: SPENT };

    const withStranger = await record(groupId, ana.token, { ...base, splitBetween: [ana.id, stranger.id] });
    const twice = await record(groupId, ana.token, { ...base, splitBetween: [ana.id, ben.id, ben.id] });
    const withoutPayer = await record(groupId, ana.token, { ...base, splitBetween: [ben.id] });

    expect(withStranger.status).toBe(400);
    expect(withStranger.body).toMatchObject({ type: 'SplitWithStranger' });
    expect(twice.status).toBe(400);
    expect(twice.body).toMatchObject({ type: 'SplitListsTwice' });
    expect(withoutPayer.status).toBe(400);
    expect(withoutPayer.body).toMatchObject({ type: 'SplitWithoutPayer' });
  });

  it('refuses a description that is only spaces, an amount out of range, and a day not yet spent', async () => {
    const ana = await accountOf('ana.values@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const base = { description: 'Coffee', amount: 300, date: SPENT, splitBetween: [ana.id] };

    const blank = await record(groupId, ana.token, { ...base, description: '     ' });
    const zero = await record(groupId, ana.token, { ...base, amount: 0 });
    const fraction = await record(groupId, ana.token, { ...base, amount: 2.5 });
    const tooMuch = await record(groupId, ana.token, { ...base, amount: 100_000_001 });
    const future = await record(groupId, ana.token, { ...base, date: FUTURE });
    const notADay = await record(groupId, ana.token, { ...base, date: '2025-02-30' });

    expect(blank.body).toMatchObject({ type: 'InvalidExpenseDescription' });
    expect(zero.body).toMatchObject({ type: 'InvalidAmount' });
    expect(tooMuch.body).toMatchObject({ type: 'InvalidAmount' });
    expect(fraction.status).toBe(400);
    expect(future.body).toMatchObject({ type: 'InvalidExpenseDate' });
    expect(notADay.body).toMatchObject({ type: 'InvalidExpenseDate' });
    for (const answer of [blank, zero, tooMuch, future, notADay]) expect(answer.status).toBe(400);
  });

  it('refuses a body missing a field, and a caller who is not signed in', async () => {
    const ana = await accountOf('ana.shape-expense@example.com', 'Ana');
    const groupId = await groupWith(ana, []);

    const missing = await record(groupId, ana.token, { description: 'Bread', amount: 100 });
    const anonymous = await record(groupId, undefined, {
      description: 'Bread',
      amount: 100,
      date: SPENT,
      splitBetween: [ana.id],
    });

    expect(missing.status).toBe(400);
    expect(anonymous.status).toBe(401);
  });

  it('answers a group that is not the caller’s as if it did not exist', async () => {
    const ana = await accountOf('ana.outsider@example.com', 'Ana');
    const eve = await accountOf('eve.outsider@example.com', 'Eve');
    const groupId = await groupWith(ana, []);

    const answer = await record(groupId, eve.token, {
      description: 'Sneaky',
      amount: 100,
      date: SPENT,
      splitBetween: [eve.id],
    });

    expect(answer.status).toBe(404);
  });
});

describe('reading an expense', () => {
  it('is answered to a member of its group only, as if it did not exist for anyone else', async () => {
    const ana = await accountOf('ana.read@example.com', 'Ana');
    const eve = await accountOf('eve.read@example.com', 'Eve');
    const groupId = await groupWith(ana, []);
    const recorded = await record(groupId, ana.token, {
      description: 'Rent share',
      amount: 400,
      date: SPENT,
      splitBetween: [ana.id],
    });
    const expenseId = (recorded.body as { id: string }).id;

    const asMember = await readExpense(expenseId, ana.token);
    const asOther = await readExpense(expenseId, eve.token);
    const anonymous = await readExpense(expenseId);
    const unknown = await readExpense('no-such-expense', ana.token);

    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({ description: 'Rent share', date: SPENT, paidBy: ana.id });
    expect(asOther.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(unknown.status).toBe(404);
  });
});

describe('editing an expense', () => {
  const base = { description: 'Dinner', amount: 900, date: SPENT };

  it('gives the expense again, whole, and computes its shares again, from the version its author read', async () => {
    const ana = await accountOf('ana.edit@example.com', 'Ana');
    const ben = await accountOf('ben.edit@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = (await record(groupId, ana.token, { ...base, splitBetween: [ana.id, ben.id] })).body as {
      id: string;
    };

    const first = await readExpense(expenseId.id, ana.token);
    expect(first.body).toMatchObject({ version: 1 });

    const edited = await editExpense(expenseId.id, ana.token, {
      description: 'Dinner, with dessert',
      amount: 1001,
      date: SPENT,
      splitBetween: [ana.id, ben.id],
      version: 1,
    });
    const read = await readExpense(expenseId.id, ben.token);

    expect(edited.status).toBe(201);
    expect(read.body).toMatchObject({
      description: 'Dinner, with dessert',
      amount: 1001,
      paidBy: ana.id,
      version: 2,
      shares: [
        { memberId: ana.id, amount: 501 },
        { memberId: ben.id, amount: 500 },
      ],
    });
  });

  it('lets the owner edit an expense a member paid, and the payer stays the one who paid', async () => {
    const ana = await accountOf('ana.owner-only@example.com', 'Ana');
    const ben = await accountOf('ben.owner-only@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = ((await record(groupId, ben.token, { ...base, splitBetween: [ben.id] })).body as { id: string })
      .id;

    const edited = await editExpense(expenseId, ana.token, {
      ...base,
      amount: 400,
      splitBetween: [ben.id, ana.id],
      version: 1,
    });
    const read = await readExpense(expenseId, ana.token);

    expect(edited.status).toBe(201);
    expect(read.body).toMatchObject({ paidBy: ben.id, amount: 400 });
  });

  it('refuses an edit by a member who is neither the payer nor the owner, and answers a stranger as if it did not exist', async () => {
    const ana = await accountOf('ana.refuse-edit@example.com', 'Ana');
    const ben = await accountOf('ben.refuse-edit@example.com', 'Ben');
    const cy = await accountOf('cy.refuse-edit@example.com', 'Cy');
    const eve = await accountOf('eve.refuse-edit@example.com', 'Eve');
    const groupId = await groupWith(ana, [ben, cy]);
    const expenseId = ((await record(groupId, ana.token, { ...base, splitBetween: [ana.id] })).body as { id: string })
      .id;
    const body = { ...base, splitBetween: [ana.id], version: 1 };

    const byOtherMember = await editExpense(expenseId, ben.token, body);
    const byStranger = await editExpense(expenseId, eve.token, body);
    const anonymous = await editExpense(expenseId, undefined, body);

    expect(byOtherMember.status).toBe(403);
    expect(byOtherMember.body).toMatchObject({ type: 'NotAllowed' });
    expect(byStranger.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect((await readExpense(expenseId, ana.token)).body).toMatchObject({ amount: 900, version: 1 });
  });

  it('refuses an edit from a version the expense has moved on from, and keeps only the edit that got there first', async () => {
    const ana = await accountOf('ana.stale@example.com', 'Ana');
    const ben = await accountOf('ben.stale@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = (
      (await record(groupId, ana.token, { ...base, splitBetween: [ana.id, ben.id] })).body as {
        id: string;
      }
    ).id;

    const first = await editExpense(expenseId, ana.token, {
      ...base,
      amount: 1200,
      splitBetween: [ana.id, ben.id],
      version: 1,
    });
    const stale = await editExpense(expenseId, ana.token, {
      ...base,
      amount: 300,
      splitBetween: [ana.id],
      version: 1,
    });

    expect(first.status).toBe(201);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ type: 'ExpenseChanged' });
    expect((await readExpense(expenseId, ana.token)).body).toMatchObject({ amount: 1200, version: 2 });
  });

  it('keeps exactly one of two edits made from the same version at once, and the balances still add up to 0', async () => {
    const ana = await accountOf('ana.race@example.com', 'Ana');
    const ben = await accountOf('ben.race@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = (
      (await record(groupId, ben.token, { ...base, splitBetween: [ana.id, ben.id] })).body as {
        id: string;
      }
    ).id;

    const [one, two] = await Promise.all([
      editExpense(expenseId, ana.token, { ...base, amount: 1000, splitBetween: [ana.id, ben.id], version: 1 }),
      editExpense(expenseId, ben.token, { ...base, amount: 2000, splitBetween: [ana.id, ben.id], version: 1 }),
    ]);
    const read = await readExpense(expenseId, ana.token);
    const balances = (await balancesOf(groupId, ana.token)).body as { memberId: string; balance: number }[];

    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect([one, two].find(answer => answer.status === 409)?.body).toMatchObject({ type: 'ExpenseChanged' });
    expect(read.body).toMatchObject({ version: 2 });
    expect([1000, 2000]).toContain((read.body as { amount: number }).amount);
    expect(balances.reduce((sum, { balance }) => sum + balance, 0)).toBe(0);
  });

  it('refuses a body missing its version, and values the rules refuse as they are refused on recording', async () => {
    const ana = await accountOf('ana.edit-values@example.com', 'Ana');
    const ben = await accountOf('ben.edit-values@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = (
      (await record(groupId, ana.token, { ...base, splitBetween: [ana.id, ben.id] })).body as {
        id: string;
      }
    ).id;

    const missing = await editExpense(expenseId, ana.token, { ...base, splitBetween: [ana.id, ben.id] });
    const withoutPayer = await editExpense(expenseId, ana.token, {
      ...base,
      splitBetween: [ben.id],
      version: 1,
    });
    const zero = await editExpense(expenseId, ana.token, { ...base, amount: 0, splitBetween: [ana.id], version: 1 });

    expect(missing.status).toBe(400);
    expect(withoutPayer.body).toMatchObject({ type: 'SplitWithoutPayer' });
    expect(zero.body).toMatchObject({ type: 'InvalidAmount' });
    expect((await readExpense(expenseId, ana.token)).body).toMatchObject({ amount: 900, version: 1 });
  });
});

describe('deleting an expense', () => {
  it('deletes it for its payer: it is read by no one, and counts in no balance', async () => {
    const ana = await accountOf('ana.delete@example.com', 'Ana');
    const ben = await accountOf('ben.delete@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = (
      (
        await record(groupId, ben.token, {
          description: 'Bread',
          amount: 300,
          date: SPENT,
          splitBetween: [ben.id, ana.id],
        })
      ).body as {
        id: string;
      }
    ).id;
    const before = (await balancesOf(groupId, ana.token)).body as { balance: number }[];

    const deleted = await deleteExpense(expenseId, ben.token);
    const after = (await balancesOf(groupId, ana.token)).body as { balance: number }[];

    expect(before.map(({ balance }) => balance)).toEqual([-150, 150]);
    expect(deleted.status).toBe(201);
    expect((await readExpense(expenseId, ana.token)).status).toBe(404);
    expect(after.map(({ balance }) => balance)).toEqual([0, 0]);
  });

  it('refuses a deletion by a member who is neither the payer nor the owner, and answers a stranger as if it did not exist', async () => {
    const ana = await accountOf('ana.refuse-delete@example.com', 'Ana');
    const ben = await accountOf('ben.refuse-delete@example.com', 'Ben');
    const cy = await accountOf('cy.refuse-delete@example.com', 'Cy');
    const eve = await accountOf('eve.refuse-delete@example.com', 'Eve');
    const groupId = await groupWith(ana, [ben, cy]);
    const expenseId = (
      (await record(groupId, ben.token, { description: 'Milk', amount: 200, date: SPENT, splitBetween: [ben.id] }))
        .body as {
        id: string;
      }
    ).id;

    const byOtherMember = await deleteExpense(expenseId, cy.token);
    const byStranger = await deleteExpense(expenseId, eve.token);
    const anonymous = await deleteExpense(expenseId);

    expect(byOtherMember.status).toBe(403);
    expect(byOtherMember.body).toMatchObject({ type: 'NotAllowed' });
    expect(byStranger.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect((await readExpense(expenseId, ben.token)).status).toBe(200);
  });
});

describe('Ledger: unequal splits (request 7)', () => {
  it('records a split by exact amounts, reads it as exact, and counts each amount in the balances', async () => {
    const ana = await accountOf('ana.exact@example.com', 'Ana');
    const ben = await accountOf('ben.exact@example.com', 'Ben');
    const cara = await accountOf('cara.exact@example.com', 'Cara');
    const groupId = await groupWith(ana, [ben, cara]);

    const recorded = await record(groupId, ana.token, {
      description: 'Lobster',
      amount: 1000,
      date: SPENT,
      splitExactly: [
        { memberId: cara.id, amount: 700 },
        { memberId: ana.id, amount: 0 },
        { memberId: ben.id, amount: 300 },
      ],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    const read = await readExpense(expenseId, ben.token);
    expect(read.body).toMatchObject({
      splitKind: 'exact',
      paidBy: ana.id,
      shares: [
        { memberId: cara.id, amount: 700 },
        { memberId: ana.id, amount: 0 },
        { memberId: ben.id, amount: 300 },
      ],
    });

    const balances = await balancesOf(groupId, ana.token);
    expect(balances.body).toEqual([
      { memberId: ana.id, balance: 1000 },
      { memberId: ben.id, balance: -300 },
      { memberId: cara.id, balance: -700 },
    ]);
  });

  it('records a split by shares, the remainder to the first member listed, and reads it as shares', async () => {
    const ana = await accountOf('ana.shares@example.com', 'Ana');
    const ben = await accountOf('ben.shares@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ben.token, {
      description: 'Cottage',
      amount: 1001,
      date: SPENT,
      splitByShares: [
        { memberId: ana.id, shares: 2 },
        { memberId: ben.id, shares: 1 },
      ],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    const read = await readExpense(expenseId, ana.token);
    expect(read.body).toMatchObject({
      splitKind: 'shares',
      paidBy: ben.id,
      shares: [
        { memberId: ana.id, amount: 668 },
        { memberId: ben.id, amount: 333 },
      ],
    });
  });

  it('says an expense recorded by an equal split is equal, and an edit gives it the split it now has', async () => {
    const ana = await accountOf('ana.kinds@example.com', 'Ana');
    const ben = await accountOf('ben.kinds@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Bread',
      amount: 1000,
      date: SPENT,
      splitBetween: [ana.id, ben.id],
    });
    const expenseId = (recorded.body as { id: string }).id;
    expect((await readExpense(expenseId, ana.token)).body).toMatchObject({ splitKind: 'equal' });

    const edited = await editExpense(expenseId, ana.token, {
      description: 'Bread and cheese',
      amount: 1000,
      date: SPENT,
      splitByShares: [
        { memberId: ana.id, shares: 1 },
        { memberId: ben.id, shares: 3 },
      ],
      version: 1,
    });
    expect(edited.status).toBe(201);
    expect(await readExpense(expenseId, ben.token)).toMatchObject({
      status: 200,
      body: {
        splitKind: 'shares',
        version: 2,
        shares: [
          { memberId: ana.id, amount: 250 },
          { memberId: ben.id, amount: 750 },
        ],
      },
    });
  });

  it('answers 400 to a body with none of the three splits, or with more than one', async () => {
    const ana = await accountOf('ana.shape@example.com', 'Ana');
    const ben = await accountOf('ben.shape@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const base = { description: 'Taxi', amount: 1000, date: SPENT };

    const none = await record(groupId, ana.token, base);
    const twoKinds = await record(groupId, ana.token, {
      ...base,
      splitBetween: [ana.id, ben.id],
      splitByShares: [{ memberId: ana.id, shares: 1 }],
    });
    const allThree = await record(groupId, ana.token, {
      ...base,
      splitBetween: [ana.id],
      splitExactly: [{ memberId: ana.id, amount: 1000 }],
      splitByShares: [{ memberId: ana.id, shares: 1 }],
    });

    expect(none.status).toBe(400);
    expect(twoKinds.status).toBe(400);
    expect(allThree.status).toBe(400);
  });

  it('refuses a split whose amounts do not add up, or a share below 1, by name, and records nothing', async () => {
    const ana = await accountOf('ana.refusals.split@example.com', 'Ana');
    const ben = await accountOf('ben.refusals.split@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);
    const base = { description: 'Hotel', amount: 1000, date: SPENT };

    const short = await record(groupId, ana.token, {
      ...base,
      splitExactly: [
        { memberId: ana.id, amount: 500 },
        { memberId: ben.id, amount: 400 },
      ],
    });
    const noShares = await record(groupId, ana.token, {
      ...base,
      splitByShares: [
        { memberId: ana.id, shares: 0 },
        { memberId: ben.id, shares: 1 },
      ],
    });

    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ type: 'SplitAmountsDoNotAddUp' });
    expect(noShares.status).toBe(400);
    expect(noShares.body).toMatchObject({ type: 'InvalidShares' });
    expect((await balancesOf(groupId, ana.token)).body).toEqual([
      { memberId: ana.id, balance: 0 },
      { memberId: ben.id, balance: 0 },
    ]);
  });
});
