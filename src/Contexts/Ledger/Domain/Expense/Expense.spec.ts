import { ConcurrencyConflictException } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

const NOW = new Date('2026-11-17T09:30:00Z');
const members = ['ada', 'bob', 'cy'];
const valid = {
  groupId: 'flat',
  description: 'Groceries',
  amount: 1000,
  date: '2026-11-16',
  paidBy: 'ada',
  split: { kind: 'equal' as const, between: ['ada', 'bob', 'cy'] },
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
      splitKind: 'equal',
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
    expect(Expense.register({ ...valid, split: { kind: 'equal' as const, between: ['ada', 'ada'] } }).error?.type).toBe(
      'DuplicateInSplit',
    );
    expect(Expense.register({ ...valid, split: { kind: 'equal' as const, between: ['ada', 'zed'] } }).error?.type).toBe(
      'NotAMemberInSplit',
    );
    expect(Expense.register({ ...valid, split: { kind: 'equal' as const, between: ['bob', 'cy'] } }).error?.type).toBe(
      'PayerNotInSplit',
    );
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
      splitKind: 'equal',
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
        splitKind: 'equal',
        shares: [{ memberId: 'ada', amount: 9 }],
        version: 1,
      }),
    ).toThrow(/corrupted/);
  });
});

describe('Expense.edit and Expense.remove', () => {
  // Ada owns the group; Bob paid the expense; Cy is a plain member.
  const roles = [
    { memberId: 'ada', role: 'owner' as const },
    { memberId: 'bob', role: 'member' as const },
    { memberId: 'cy', role: 'member' as const },
  ];
  /** The expense as the store keeps it after its recording: version 1, paid by Bob, split equally. */
  const stored = () =>
    Expense.fromSnapshot({
      id: 'e1',
      groupId: 'flat',
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      paidBy: 'bob',
      splitKind: 'equal',
      shares: [
        { memberId: 'bob', amount: 334 },
        { memberId: 'ada', amount: 333 },
        { memberId: 'cy', amount: 333 },
      ],
      version: 1,
    });
  const edit = (overrides: Partial<Parameters<Expense['edit']>[0]> = {}) =>
    stored().edit({
      by: 'bob',
      members: roles,
      version: 1,
      description: 'Groceries, again',
      amount: 900,
      date: '2026-11-16',
      split: { kind: 'equal' as const, between: ['bob', 'ada'] },
      at: NOW,
      ...overrides,
    });

  it('gives the expense again, whole, keeping the payer, and records ExpenseEdited at the version it was read at', () => {
    const edited = edit({ split: { kind: 'equal' as const, between: ['cy', 'bob', 'ada'] } });

    expect(edited.isSuccess()).toBe(true);
    expect(edited.data?.toSnapshot()).toMatchObject({
      description: 'Groceries, again',
      amount: 900,
      paidBy: 'bob',
      splitKind: 'equal',
      shares: [
        { memberId: 'cy', amount: 300 },
        { memberId: 'bob', amount: 300 },
        { memberId: 'ada', amount: 300 },
      ],
      version: 1,
    });
    expect(edited.data?.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseEditedEvent']);
  });

  it('lets the group owner edit an expense another member paid, and the payer stays the one who paid', () => {
    const edited = edit({ by: 'ada', split: { kind: 'equal' as const, between: ['ada', 'bob'] } });
    expect(edited.isSuccess()).toBe(true);
    expect(edited.data?.paidBy).toBe('bob');
  });

  it('refuses an edit to anyone but the payer and the group owner, by name', () => {
    expect(edit({ by: 'cy' }).error?.type).toBe('NotAllowed');
  });

  it('refuses an edit made from a version the expense has moved past, by name, as a conflict', () => {
    const refused = edit({ version: 0 });

    expect(refused.error?.type).toBe('ExpenseChanged');
    expect(refused.error).toBeInstanceOf(ConcurrencyConflictException);
  });

  it('refuses an edit that the rules of a creation refuse: a split without the payer, a future date, a bad amount', () => {
    expect(edit({ by: 'ada', split: { kind: 'equal' as const, between: ['ada', 'cy'] } }).error?.type).toBe(
      'PayerNotInSplit',
    );
    expect(edit({ date: '2026-11-18' }).error?.type).toBe('InvalidDate');
    expect(edit({ amount: 0 }).error?.type).toBe('InvalidAmount');
    expect(edit({ split: { kind: 'equal' as const, between: ['bob', 'zed'] } }).error?.type).toBe('NotAMemberInSplit');
  });

  it('removes the expense for its payer or the owner, and records ExpenseDeleted; another member is refused', () => {
    const removed = stored().remove({ by: 'bob', members: roles });
    expect(removed.isSuccess()).toBe(true);
    expect(removed.data?.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseDeletedEvent']);

    expect(stored().remove({ by: 'ada', members: roles }).isSuccess()).toBe(true);
    expect(stored().remove({ by: 'cy', members: roles }).error?.type).toBe('NotAllowed');
  });
});
