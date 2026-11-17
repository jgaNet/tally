import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

const NOW = new Date('2026-11-17T09:30:00Z');
const members = ['ada', 'bob', 'cy'];
const valid = {
  groupId: 'flat',
  description: 'Groceries',
  amount: 1000,
  date: '2026-11-16',
  paidBy: 'ada',
  splitBetween: ['ada', 'bob', 'cy'],
  members,
  at: NOW,
};

describe('Expense.register', () => {
  it('records an expense with its split, and records ExpenseRecorded', () => {
    const expense = Expense.register(valid);

    expect(expense.isSuccess()).toBe(true);
    expect(expense.data?.id).toEqual(expect.any(String));
    expect(expense.data?.toSnapshot()).toMatchObject({
      groupId: 'flat',
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      paidBy: 'ada',
      shares: [
        { memberId: 'ada', amount: 334 },
        { memberId: 'bob', amount: 333 },
        { memberId: 'cy', amount: 333 },
      ],
      version: 0,
    });
    expect(expense.data?.pullDomainEvents()).toHaveLength(1);
  });

  it('trims the description, and refuses one of 0 or more than 100 characters, or only spaces', () => {
    expect(Expense.register({ ...valid, description: '  Rent  ' }).data?.toSnapshot().description).toBe('Rent');
    expect(Expense.register({ ...valid, description: '   ' }).error?.type).toBe('InvalidDescription');
    expect(Expense.register({ ...valid, description: '' }).error?.type).toBe('InvalidDescription');
    expect(Expense.register({ ...valid, description: 'x'.repeat(101) }).error?.type).toBe('InvalidDescription');
    expect(Expense.register({ ...valid, description: 'x'.repeat(100) }).isSuccess()).toBe(true);
  });

  it('refuses an amount that is not a whole number from 1 to 100 000 000', () => {
    for (const amount of [0, -1, 1.5, 100_000_001]) {
      expect(Expense.register({ ...valid, amount }).error?.type).toBe('InvalidAmount');
    }
    expect(Expense.register({ ...valid, amount: 1 }).isSuccess()).toBe(true);
    expect(Expense.register({ ...valid, amount: 100_000_000 }).isSuccess()).toBe(true);
  });

  it('refuses a date that is not a real day, or is after today in UTC; today itself is allowed', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-11-18', '17/11/2026', '2026-11-1']) {
      expect(Expense.register({ ...valid, date }).error?.type).toBe('InvalidDate');
    }
    expect(Expense.register({ ...valid, date: '2026-11-17' }).isSuccess()).toBe(true);
  });

  it('refuses a split the members do not allow', () => {
    expect(Expense.register({ ...valid, splitBetween: ['ada', 'ada'] }).error?.type).toBe('DuplicateInSplit');
    expect(Expense.register({ ...valid, splitBetween: ['ada', 'zed'] }).error?.type).toBe('NotAMemberInSplit');
    expect(Expense.register({ ...valid, splitBetween: ['bob', 'cy'] }).error?.type).toBe('PayerNotInSplit');
  });
});

describe('Expense.fromSnapshot', () => {
  it('reads what the store kept, and records nothing', () => {
    const expense = Expense.fromSnapshot({
      id: 'e1',
      groupId: 'flat',
      description: 'Groceries',
      amount: 10,
      date: '2026-11-16',
      paidBy: 'ada',
      shares: [
        { memberId: 'ada', amount: 5 },
        { memberId: 'bob', amount: 5 },
      ],
      version: 1,
    });

    expect(expense.pullDomainEvents()).toHaveLength(0);
    expect(expense.toSnapshot().version).toBe(1);
  });

  it('throws on corrupted data: shares that do not add up to the amount', () => {
    expect(() =>
      Expense.fromSnapshot({
        id: 'e1',
        groupId: 'flat',
        description: 'Groceries',
        amount: 10,
        date: '2026-11-16',
        paidBy: 'ada',
        shares: [{ memberId: 'ada', amount: 9 }],
        version: 1,
      }),
    ).toThrow(/corrupted/);
  });
});
