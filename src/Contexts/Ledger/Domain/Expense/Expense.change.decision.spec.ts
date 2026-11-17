import { Expense, ExpenseSnapshot } from './Expense';
import { decideDeleteExpense, decideEditExpense, EditExpenseCommand } from './Expense.decision';

const payer = 'ada';
const owner = 'grace';
const other = 'linus';
const now = new Date('2026-11-17T10:00:00Z');

/** An expense as it is stored, recorded by `payer` and split equally between the three, at version 1. */
const stored: ExpenseSnapshot = {
  id: '6f1d2c3b-0000-4000-8000-000000000001',
  groupId: 'group',
  description: 'Groceries',
  amount: 1000,
  date: '2026-11-16',
  paidBy: payer,
  shares: [
    { memberId: payer, amount: 334 },
    { memberId: owner, amount: 333 },
    { memberId: other, amount: 333 },
  ],
  version: 1,
};
const access = { expense: stored, memberIds: [payer, owner, other], ownerId: owner };

const edit = (overrides: Partial<EditExpenseCommand> = {}): EditExpenseCommand => ({
  by: payer,
  description: 'Groceries, again',
  amount: 900,
  date: '2026-11-15',
  splitBetween: [payer, owner],
  version: 1,
  ...overrides,
});

describe('who may edit an expense', () => {
  it('lets its payer edit it, and the group owner, and refuses any other member by name', () => {
    expect(decideEditExpense(access, edit({ by: payer }), now).isSuccess()).toBe(true);
    expect(decideEditExpense(access, edit({ by: owner }), now).isSuccess()).toBe(true);
    expect(decideEditExpense(access, edit({ by: other }), now).error).toMatchObject({ type: 'NotAllowed' });
  });

  it('keeps the payer when the owner edits, and the split still holds the payer', () => {
    const decision = decideEditExpense(access, edit({ by: owner, splitBetween: [payer, other] }), now);
    expect(decision.isSuccess()).toBe(true);
    expect(decision.data?.state.split.payer).toBe(payer);
    expect(decision.data?.state.split.shares).toEqual([
      { memberId: payer, amount: 450 },
      { memberId: other, amount: 450 },
    ]);
  });

  it('refuses an edit that leaves the payer out of the split, whoever makes it', () => {
    expect(decideEditExpense(access, edit({ by: owner, splitBetween: [owner, other] }), now).error).toMatchObject({
      type: 'PayerNotInSplit',
    });
  });
});

describe('the version an edit is made from', () => {
  it('refuses an edit made from a version the expense has left, by name', () => {
    expect(decideEditExpense(access, edit({ version: 2 }), now).error).toMatchObject({
      type: 'ExpenseChangedSinceRead',
    });
    expect(decideEditExpense(access, edit({ version: 0 }), now).error).toMatchObject({
      type: 'ExpenseChangedSinceRead',
    });
  });

  it('answers who may first, so a stranger to the expense is not told about its version', () => {
    expect(decideEditExpense(access, edit({ by: other, version: 2 }), now).error).toMatchObject({ type: 'NotAllowed' });
  });
});

describe('the values of an edit', () => {
  it('are the same rules as a recording: a description, an amount, a real day not after today, and the members', () => {
    expect(decideEditExpense(access, edit({ description: '   ' }), now).error).toMatchObject({
      type: 'InvalidExpenseDescription',
    });
    expect(decideEditExpense(access, edit({ amount: 0 }), now).error).toMatchObject({ type: 'InvalidExpenseAmount' });
    expect(decideEditExpense(access, edit({ date: '2026-11-18' }), now).error).toMatchObject({
      type: 'InvalidExpenseDate',
    });
    expect(decideEditExpense(access, edit({ splitBetween: [payer, 'stranger'] }), now).error).toMatchObject({
      type: 'SplitMemberNotInGroup',
    });
  });

  it('computes the shares again from what the edit gives', () => {
    const decision = decideEditExpense(access, edit({ amount: 10, splitBetween: [payer, owner, other] }), now);
    expect(decision.data?.state.split.shares).toEqual([
      { memberId: payer, amount: 4 },
      { memberId: owner, amount: 3 },
      { memberId: other, amount: 3 },
    ]);
  });
});

describe('deleting an expense', () => {
  it('lets its payer and the owner delete it, and refuses any other member', () => {
    expect(decideDeleteExpense(access, { by: payer }, now).isSuccess()).toBe(true);
    expect(decideDeleteExpense(access, { by: owner }, now).isSuccess()).toBe(true);
    expect(decideDeleteExpense(access, { by: other }, now).error).toMatchObject({ type: 'NotAllowed' });
  });
});

describe('an expense as it is stored', () => {
  it('is rebuilt at the version it was stored at, and records nothing', () => {
    const expense = Expense.fromSnapshot({ ...stored, version: 3 });
    expect(expense.version).toBe(3);
    expect(expense.pullDomainEvents()).toEqual([]);
    expect(expense.toSnapshot()).toEqual({ ...stored, version: 3 });
  });

  it('is refused when its shares are not the equal split of its amount', () => {
    const corrupted = {
      ...stored,
      shares: [
        { memberId: payer, amount: 600 },
        { memberId: owner, amount: 400 },
      ],
    };
    expect(() => Expense.fromSnapshot(corrupted)).toThrow(/corrupted/);
  });

  it('records ExpenseEdited when it is revised, and ExpenseDeleted when it is deleted', () => {
    const expense = Expense.fromSnapshot(stored);
    const decision = decideEditExpense(access, edit({ splitBetween: [payer, owner] }), now);
    expense.revise(decision.data!.state);
    expect(expense.toSnapshot().version).toBe(1);
    expect(expense.pullDomainEvents().map(event => event.name)).toEqual(['ExpenseEditedEvent']);

    expense.delete();
    expect(expense.pullDomainEvents().map(event => event.name)).toEqual(['ExpenseDeletedEvent']);
  });
});
