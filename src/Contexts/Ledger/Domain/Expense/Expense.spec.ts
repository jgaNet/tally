import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

const today = new Date('2026-11-17T12:00:00.000Z');
const base = { groupId: 'group', description: 'Groceries', amount: 1000, date: '2026-11-16', today };

describe('Split.equally', () => {
  it('gives each member the amount divided by their number, rounded down, the remainder to the first member listed', () => {
    const shares = Split.equally({ amount: 1000, memberIds: ['ben', 'cara', 'ana'] });

    expect(shares).toEqual([
      { memberId: 'ben', amount: 334 },
      { memberId: 'cara', amount: 333 },
      { memberId: 'ana', amount: 333 },
    ]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
  });
});

describe('Expense.create', () => {
  it('records the expense with its shares in the order of the split, and records ExpenseRecorded', () => {
    const created = Expense.create({
      ...base,
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ben', 'ana'] },
      members: ['ana', 'ben'],
    });

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
    const events = created.data.pullDomainEvents();
    expect(events.map(event => event.constructor.name)).toEqual(['ExpenseRecordedEvent']);
    // What Notifications needs to tell each member of the split their share (request 17) travels with the fact.
    expect(events[0].payload).toMatchObject({
      groupId: 'group',
      paidBy: 'ana',
      amount: 1000,
      shares: [
        { memberId: 'ben', amount: 500 },
        { memberId: 'ana', amount: 500 },
      ],
    });
  });

  it('refuses a split with a stranger, a member listed twice, or no payer, as a failed Result', () => {
    const stranger = Expense.create({
      ...base,
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ana', 'zoe'] },
      members: ['ana', 'ben'],
    });
    const twice = Expense.create({
      ...base,
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ana', 'ana'] },
      members: ['ana', 'ben'],
    });
    const noPayer = Expense.create({
      ...base,
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ben'] },
      members: ['ana', 'ben'],
    });

    expect(stranger.isFailure() && stranger.error.type).toBe('SplitWithStranger');
    expect(twice.isFailure() && twice.error.type).toBe('SplitListsTwice');
    expect(noPayer.isFailure() && noPayer.error.type).toBe('SplitWithoutPayer');
  });

  it('refuses a day after today in UTC, and a day that is not on the calendar', () => {
    const future = Expense.create({
      ...base,
      date: '2026-11-18',
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ana'] },
      members: ['ana'],
    });
    const leap = Expense.create({
      ...base,
      date: '2026-02-29',
      paidBy: 'ana',
      split: { kind: 'equal', memberIds: ['ana'] },
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
      split: { kind: 'equal', memberIds: ['ben', 'ana'] },
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
      split: { kind: 'equal', memberIds: ['ben', 'ana', 'cara'] },
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
    const refused = edit({ split: { kind: 'equal', memberIds: ['ana', 'cara'] } });

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

describe('Expense.create by exact amounts', () => {
  const exact = (amounts: { memberId: string; amount: number }[], amount = 1000) =>
    Expense.create({
      ...base,
      amount,
      paidBy: 'ana',
      split: { kind: 'exact', amounts },
      members: ['ana', 'ben', 'cara'],
    });

  it('gives each member the amount they were given, in the order given, and says the split was exact', () => {
    const created = exact([
      { memberId: 'ben', amount: 600 },
      { memberId: 'ana', amount: 0 },
      { memberId: 'cara', amount: 400 },
    ]);

    expect(created.isSuccess()).toBe(true);
    if (created.isFailure()) return;
    expect(created.data.splitKind).toBe('exact');
    expect(created.data.toSnapshot()).toMatchObject({
      splitKind: 'exact',
      shares: [
        { memberId: 'ben', amount: 600 },
        { memberId: 'ana', amount: 0 },
        { memberId: 'cara', amount: 400 },
      ],
    });
  });

  it('refuses amounts that do not add up to the amount of the expense, as a failed Result', () => {
    const short = exact([
      { memberId: 'ben', amount: 600 },
      { memberId: 'ana', amount: 300 },
    ]);

    expect(short.isFailure() && short.error.type).toBe('SplitAmountsDoNotAddUp');
  });

  it('refuses an amount below 0, or not whole, as InvalidSplitAmount', () => {
    const negative = exact([
      { memberId: 'ben', amount: 1100 },
      { memberId: 'ana', amount: -100 },
    ]);
    const fraction = exact([
      { memberId: 'ben', amount: 500.5 },
      { memberId: 'ana', amount: 499.5 },
    ]);

    expect(negative.isFailure() && negative.error.type).toBe('InvalidSplitAmount');
    expect(fraction.isFailure() && fraction.error.type).toBe('InvalidSplitAmount');
  });

  it('refuses a stranger, and a split that leaves out the payer, as the rules refuse any split', () => {
    const stranger = Expense.create({
      ...base,
      paidBy: 'ana',
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'ana', amount: 500 },
          { memberId: 'zoe', amount: 500 },
        ],
      },
      members: ['ana', 'ben'],
    });
    const noPayer = exact([{ memberId: 'ben', amount: 1000 }]);

    expect(stranger.isFailure() && stranger.error.type).toBe('SplitWithStranger');
    expect(noPayer.isFailure() && noPayer.error.type).toBe('SplitWithoutPayer');
  });
});

describe('Expense.create by shares', () => {
  const byShares = (shares: { memberId: string; shares: number }[], amount = 1000, paidBy = 'ana') =>
    Expense.create({
      ...base,
      amount,
      paidBy,
      split: { kind: 'shares', shares },
      members: ['ana', 'ben', 'cara'],
    });

  it('gives 1000 by shares of 1, 1 and 1 the equal split of request 4, the remainder to the first member listed', () => {
    const created = byShares([
      { memberId: 'ben', shares: 1 },
      { memberId: 'cara', shares: 1 },
      { memberId: 'ana', shares: 1 },
    ]);

    expect(created.isSuccess()).toBe(true);
    if (created.isFailure()) return;
    expect(created.data.toSnapshot()).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: 'ben', amount: 334 },
        { memberId: 'cara', amount: 333 },
        { memberId: 'ana', amount: 333 },
      ],
    });
  });

  it('gives 1001 by shares of 2 and 1, the payer listed second, the first listed 668 and the payer 333', () => {
    const created = byShares(
      [
        { memberId: 'ben', shares: 2 },
        { memberId: 'ana', shares: 1 },
      ],
      1001,
    );

    expect(created.isSuccess()).toBe(true);
    if (created.isFailure()) return;
    expect(created.data.toSnapshot().shares).toEqual([
      { memberId: 'ben', amount: 668 },
      { memberId: 'ana', amount: 333 },
    ]);
  });

  it('refuses a member with less than 1 share, or not a whole number of them, as InvalidShares', () => {
    const none = byShares([
      { memberId: 'ben', shares: 0 },
      { memberId: 'ana', shares: 1 },
    ]);
    const fraction = byShares([
      { memberId: 'ben', shares: 1.5 },
      { memberId: 'ana', shares: 1 },
    ]);

    expect(none.isFailure() && none.error.type).toBe('InvalidShares');
    expect(fraction.isFailure() && fraction.error.type).toBe('InvalidShares');
  });

  it('does not lose precision in a share of a large amount and large shares', () => {
    const created = byShares(
      [
        { memberId: 'ben', shares: 9_007_199_254_740_991 },
        { memberId: 'ana', shares: 1 },
      ],
      100_000_000,
    );

    expect(created.isSuccess()).toBe(true);
    if (created.isFailure()) return;
    const total = created.data.toSnapshot().shares.reduce((sum, share) => sum + share.amount, 0);
    expect(total).toBe(100_000_000);
  });

  it('keeps the kind of an expense it was edited into, and says so when it is read again', () => {
    const recorded = Expense.create({
      ...base,
      paidBy: 'ben',
      split: { kind: 'equal', memberIds: ['ben', 'ana'] },
      members: ['ana', 'ben'],
    });
    if (recorded.isFailure()) throw recorded.error;
    const expense = Expense.fromSnapshot({ ...recorded.data.toSnapshot(), version: 1 });

    const edited = expense.edit({
      editedBy: 'ben',
      members: [
        { memberId: 'ana', role: 'owner' },
        { memberId: 'ben', role: 'member' },
      ],
      version: 1,
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ben', shares: 3 },
          { memberId: 'ana', shares: 1 },
        ],
      },
      today,
    });

    expect(edited.isSuccess()).toBe(true);
    if (edited.isFailure()) return;
    expect(edited.data.toSnapshot()).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: 'ben', amount: 750 },
        { memberId: 'ana', amount: 250 },
      ],
    });
    expect(Expense.fromSnapshot(edited.data.toSnapshot()).splitKind).toBe('shares');
  });
});

describe('Expense of a former member', () => {
  const recorded = () => {
    const created = Expense.create({
      ...base,
      paidBy: 'ben',
      split: { kind: 'equal', memberIds: ['ben', 'ana'] },
      members: ['ana', 'ben', 'cara'],
    });
    if (created.isFailure()) throw created.error;
    return Expense.fromSnapshot({ ...created.data.toSnapshot(), version: 1 });
  };
  // Ben left the group: the expense concerns him as its payer.
  const withoutBen = [
    { memberId: 'ana', role: 'owner' as const },
    { memberId: 'cara', role: 'member' as const },
  ];
  // Ana left the group: the expense concerns her in its split, so not even its payer may change it.
  const withoutAna = [
    { memberId: 'ben', role: 'member' as const },
    { memberId: 'cara', role: 'member' as const },
  ];

  it('refuses an edit or a deletion whoever asks, once its payer or a member of its split has left', () => {
    const editedByOwner = recorded().edit({
      editedBy: 'ana',
      members: withoutBen,
      version: 1,
      description: 'Groceries, again',
      amount: 1000,
      date: '2026-11-16',
      split: { kind: 'equal', memberIds: ['ben', 'ana'] },
      today,
    });
    const deletedByOwner = recorded().delete({ deletedBy: 'ana', members: withoutBen });
    const editedByPayer = recorded().edit({
      editedBy: 'ben',
      members: withoutAna,
      version: 1,
      description: 'Groceries, again',
      amount: 1000,
      date: '2026-11-16',
      split: { kind: 'equal', memberIds: ['ben', 'cara'] },
      today,
    });

    expect(editedByOwner.isFailure() && editedByOwner.error.type).toBe('ExpenseOfFormerMember');
    expect(deletedByOwner.isFailure() && deletedByOwner.error.type).toBe('ExpenseOfFormerMember');
    expect(editedByPayer.isFailure() && editedByPayer.error.type).toBe('ExpenseOfFormerMember');
  });

  it('lets the expense change again when its former member joins again', () => {
    const rejoined = [
      { memberId: 'ana', role: 'owner' as const },
      { memberId: 'ben', role: 'member' as const },
      { memberId: 'cara', role: 'member' as const },
    ];

    expect(recorded().delete({ deletedBy: 'ana', members: rejoined }).isSuccess()).toBe(true);
  });
});
