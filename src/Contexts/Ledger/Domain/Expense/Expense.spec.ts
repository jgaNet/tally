import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

const today = new Date('2026-11-17T12:00:00.000Z');
const base = { groupId: 'group', description: 'Groceries', amount: 1000, date: '2026-11-16', today };

describe('Split.equally', () => {
  it('gives each member the amount divided by their number, rounded down, the remainder to the payer', () => {
    const shares = Split.equally({ amount: 1000, memberIds: ['ben', 'cara', 'ana'], payerId: 'ana' });

    expect(shares).toEqual([
      { memberId: 'ben', amount: 333 },
      { memberId: 'cara', amount: 333 },
      { memberId: 'ana', amount: 334 },
    ]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
  });
});

describe('Expense.create', () => {
  it('records the expense with its shares in the order of the split, and records ExpenseRecorded', () => {
    const created = Expense.create({ ...base, paidBy: 'ana', splitBetween: ['ben', 'ana'], members: ['ana', 'ben'] });

    expect(created.isSuccess()).toBe(true);
    if (created.isFailure()) return;
    expect(created.data.toSnapshot()).toMatchObject({
      groupId: 'group',
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      paidBy: 'ana',
      shares: [
        { memberId: 'ben', amount: 500 },
        { memberId: 'ana', amount: 500 },
      ],
    });
    expect(created.data.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseRecordedEvent']);
  });

  it('refuses a split with a stranger, a member listed twice, or no payer, as a failed Result', () => {
    const stranger = Expense.create({ ...base, paidBy: 'ana', splitBetween: ['ana', 'zoe'], members: ['ana', 'ben'] });
    const twice = Expense.create({ ...base, paidBy: 'ana', splitBetween: ['ana', 'ana'], members: ['ana', 'ben'] });
    const noPayer = Expense.create({ ...base, paidBy: 'ana', splitBetween: ['ben'], members: ['ana', 'ben'] });

    expect(stranger.isFailure() && stranger.error.type).toBe('SplitWithStranger');
    expect(twice.isFailure() && twice.error.type).toBe('SplitListsTwice');
    expect(noPayer.isFailure() && noPayer.error.type).toBe('SplitWithoutPayer');
  });

  it('refuses a day after today in UTC, and a day that is not on the calendar', () => {
    const future = Expense.create({
      ...base,
      date: '2026-11-18',
      paidBy: 'ana',
      splitBetween: ['ana'],
      members: ['ana'],
    });
    const leap = Expense.create({
      ...base,
      date: '2026-02-29',
      paidBy: 'ana',
      splitBetween: ['ana'],
      members: ['ana'],
      today,
    });

    expect(future.isFailure() && future.error.type).toBe('InvalidExpenseDate');
    expect(leap.isFailure() && leap.error.type).toBe('InvalidExpenseDate');
  });
});

describe('Expense.edit and Expense.delete', () => {
  const members = [
    { memberId: 'ana', role: 'owner' as const },
    { memberId: 'ben', role: 'member' as const },
    { memberId: 'cara', role: 'member' as const },
  ];
  const recorded = () => {
    const created = Expense.create({
      ...base,
      paidBy: 'ben',
      splitBetween: ['ben', 'ana'],
      members: ['ana', 'ben', 'cara'],
    });
    if (created.isFailure()) throw created.error;
    return Expense.fromSnapshot({ ...created.data.toSnapshot(), version: 1 });
  };
  const edit = (overrides: Partial<Parameters<Expense['edit']>[0]> = {}) =>
    recorded().edit({
      editedBy: 'ben',
      members,
      version: 1,
      description: 'Groceries, again',
      amount: 1001,
      date: '2026-11-16',
      splitBetween: ['ben', 'ana', 'cara'],
      today,
      ...overrides,
    });

  it('gives the expense again, its shares computed again, and keeps the payer, at the version it was read at', () => {
    const edited = edit({ editedBy: 'ana' });

    expect(edited.isSuccess()).toBe(true);
    if (edited.isFailure()) return;
    expect(edited.data.toSnapshot()).toMatchObject({
      paidBy: 'ben',
      amount: 1001,
      version: 1,
      shares: [
        { memberId: 'ben', amount: 334 + 1 },
        { memberId: 'ana', amount: 333 },
        { memberId: 'cara', amount: 333 },
      ],
    });
    expect(edited.data.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseEditedEvent']);
  });

  it('refuses an edit by a member who is neither the payer nor the owner, as NotAllowed', () => {
    const refused = edit({ editedBy: 'cara' });

    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
  });

  it('refuses an edit from another version than the one read, as ExpenseChanged, and keeps nothing of it', () => {
    const refused = edit({ version: 2 });

    expect(refused.isFailure() && refused.error.type).toBe('ExpenseChanged');
  });

  it('refuses an edit whose split leaves out the payer, as the rules refuse a recording', () => {
    const refused = edit({ splitBetween: ['ana', 'cara'] });

    expect(refused.isFailure() && refused.error.type).toBe('SplitWithoutPayer');
  });

  it('lets the owner delete an expense of a member, and records ExpenseDeleted; a member who is neither is refused', () => {
    const expense = recorded();
    const refused = expense.delete({ deletedBy: 'cara', members });
    const deleted = expense.delete({ deletedBy: 'ana', members });

    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
    expect(deleted.isSuccess()).toBe(true);
    expect(expense.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseDeletedEvent']);
  });
});
