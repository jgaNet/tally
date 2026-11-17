import { describe, expect, it } from '@jest/globals';

import { Expense, ExpenseDraft } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

const now = new Date('2026-11-17T12:00:00Z');
const members = ['ann', 'bob', 'carol'];
const draft = (overrides: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  groupId: 'flat',
  description: 'Groceries',
  amount: 1000,
  date: '2026-11-17',
  payerId: 'ann',
  splitBetween: ['ann', 'bob', 'carol'],
  ...overrides,
});

describe('Split', () => {
  it('divides the amount equally, the remainder whole to the payer, and the shares add up to the amount', () => {
    const split = Split.equally({ amount: 1000, payerId: 'ann', memberIds: ['ann', 'bob', 'carol'] });
    expect(split.data?.shares).toEqual([
      { memberId: 'ann', amount: 334 },
      { memberId: 'bob', amount: 333 },
      { memberId: 'carol', amount: 333 },
    ]);
  });

  it('gives the remainder to a payer who is not first, and keeps the order given', () => {
    const split = Split.equally({ amount: 10, payerId: 'bob', memberIds: ['carol', 'bob', 'ann'] });
    expect(split.data?.shares).toEqual([
      { memberId: 'carol', amount: 3 },
      { memberId: 'bob', amount: 4 },
      { memberId: 'ann', amount: 3 },
    ]);
  });

  it('refuses a member listed twice, and a split without its payer', () => {
    expect(Split.equally({ amount: 10, payerId: 'ann', memberIds: ['ann', 'ann'] }).error?.type).toBe(
      'DuplicateSplitMember',
    );
    expect(Split.equally({ amount: 10, payerId: 'ann', memberIds: ['bob'] }).error?.type).toBe('PayerNotInSplit');
  });
});

describe('Expense.register', () => {
  it('records the expense with its shares, and announces it with ExpenseRecorded', () => {
    const expense = Expense.register(draft(), members, now);
    expect(expense.isFailure()).toBe(false);
    const snapshot = expense.data!.toSnapshot();
    expect(snapshot).toMatchObject({ groupId: 'flat', amount: 1000, date: '2026-11-17', paidBy: 'ann' });
    expect(snapshot.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
    expect(expense.data!.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseRecordedEvent']);
  });

  it('refuses a member of the split who is not a member of the group', () => {
    const refused = Expense.register(draft({ splitBetween: ['ann', 'dana'] }), members, now);
    expect(refused.error?.type).toBe('SplitMemberNotInGroup');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['101 characters', 'x'.repeat(101)],
  ])('refuses a description that is %s', (_label, description) => {
    expect(Expense.register(draft({ description }), members, now).error?.type).toBe('InvalidExpenseDescription');
  });

  it('accepts a description of exactly 100 characters', () => {
    expect(Expense.register(draft({ description: 'x'.repeat(100) }), members, now).isFailure()).toBe(false);
  });

  it.each([0, -5, 1.5, 100_000_001])('refuses the amount %s', amount => {
    expect(Expense.register(draft({ amount }), members, now).error?.type).toBe('InvalidExpenseAmount');
  });

  it('accepts the bounds of the amount', () => {
    expect(Expense.register(draft({ amount: 1 }), members, now).isFailure()).toBe(false);
    expect(Expense.register(draft({ amount: 100_000_000 }), members, now).isFailure()).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '17/11/2026', '2026-11-17T10:00:00Z'])('refuses the date %s', date => {
    expect(Expense.register(draft({ date }), members, now).error?.type).toBe('InvalidExpenseDate');
  });

  it('accepts today in UTC and refuses tomorrow', () => {
    expect(Expense.register(draft({ date: '2026-11-17' }), members, now).isFailure()).toBe(false);
    expect(Expense.register(draft({ date: '2026-11-18' }), members, now).error?.type).toBe('InvalidExpenseDate');
  });
});
