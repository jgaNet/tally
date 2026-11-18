import { describe, expect, it } from '@jest/globals';

import { EditDraft, Expense, ExpenseDraft } from '@Contexts/Ledger/Domain/Expense/Expense';

const now = new Date('2026-11-17T12:00:00Z');
const members = ['ann', 'bob', 'carol'];
const draft = (overrides: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  groupId: 'flat',
  groupCurrency: 'EUR',
  description: 'Groceries',
  amount: 1000,
  date: '2026-11-17',
  payerId: 'ann',
  split: { kind: 'equal', memberIds: ['ann', 'bob', 'carol'] },
  ...overrides,
});

describe('Expense.register', () => {
  it('records the expense with its shares, and announces it with ExpenseRecorded', () => {
    const expense = Expense.register(draft(), members, now);
    expect(expense.isFailure()).toBe(false);
    const snapshot = expense.data!.toSnapshot();
    expect(snapshot).toMatchObject({
      groupId: 'flat',
      amount: 1000,
      date: '2026-11-17',
      paidBy: 'ann',
      splitKind: 'equal',
    });
    expect(snapshot.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
    expect(expense.data!.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseRecordedEvent']);
  });

  it('records an expense split by shares with its kind, and its ExpenseRecorded says how it was split', () => {
    const expense = Expense.register(
      draft({
        amount: 1001,
        payerId: 'bob',
        split: {
          kind: 'shares',
          shares: [
            { memberId: 'ann', shares: 2 },
            { memberId: 'bob', shares: 1 },
          ],
        },
      }),
      members,
      now,
    );
    expect(expense.isFailure()).toBe(false);
    expect(expense.data!.toSnapshot()).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: 'ann', amount: 668 },
        { memberId: 'bob', amount: 333 },
      ],
    });
    const [event] = expense.data!.pullDomainEvents() as unknown as { payload: { splitKind: string } }[];
    expect(event.payload.splitKind).toBe('shares');
  });

  it('refuses a member of the split who is not a member of the group', () => {
    const refused = Expense.register(draft({ split: { kind: 'equal', memberIds: ['ann', 'dana'] } }), members, now);
    expect(refused.error?.type).toBe('SplitMemberNotInGroup');
  });

  it('refuses a split by exact amounts that names a member of the group twice, or not of it', () => {
    const twice = Expense.register(
      draft({
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'ann', amount: 500 },
            { memberId: 'ann', amount: 500 },
          ],
        },
      }),
      members,
      now,
    );
    expect(twice.error?.type).toBe('DuplicateSplitMember');
    const stranger = Expense.register(
      draft({
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'ann', amount: 500 },
            { memberId: 'dana', amount: 500 },
          ],
        },
      }),
      members,
      now,
    );
    expect(stranger.error?.type).toBe('SplitMemberNotInGroup');
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

describe('Expense.edit', () => {
  const recorded = () => Expense.register(draft(), members, now).data!;
  /** The expense as the store would have loaded it: at version 1, as a recording stores it. */
  const loaded = () => Expense.fromSnapshot({ ...recorded().toSnapshot(), version: 1 });
  const edit: EditDraft = {
    groupCurrency: 'EUR',
    description: 'Dinner',
    amount: 900,
    date: '2026-11-16',
    split: { kind: 'equal', memberIds: ['ann', 'bob'] },
  };

  it('gives the expense again whole, its shares computed again, the payer kept, and records ExpenseEdited', () => {
    const expense = loaded();
    expect(expense.edit(edit, members, 1, now).isFailure()).toBe(false);
    expect(expense.toSnapshot()).toMatchObject({
      description: 'Dinner',
      amount: 900,
      date: '2026-11-16',
      paidBy: 'ann',
      shares: [
        { memberId: 'ann', amount: 450 },
        { memberId: 'bob', amount: 450 },
      ],
    });
    expect(expense.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseEditedEvent']);
  });

  it('refuses an edit made from another version than the one the expense is at, before anything else', () => {
    const refused = loaded().edit({ ...edit, amount: 0 }, members, 2, now);
    expect(refused.error?.type).toBe('ExpenseChanged');
  });

  it('applies the rules of a recording to what it gives: a split without the payer is refused and nothing changes', () => {
    const expense = loaded();
    expect(expense.edit({ ...edit, split: { kind: 'equal', memberIds: ['bob'] } }, members, 1, now).error?.type).toBe(
      'PayerNotInSplit',
    );
    expect(expense.toSnapshot().amount).toBe(1000);
    expect(expense.pullDomainEvents()).toEqual([]);
  });

  it('refuses a member of the split who is not a member of the group', () => {
    expect(
      loaded().edit({ ...edit, split: { kind: 'equal', memberIds: ['ann', 'dana'] } }, members, 1, now).error?.type,
    ).toBe('SplitMemberNotInGroup');
  });
});

describe('Expense.delete', () => {
  it('records ExpenseDeleted', () => {
    const expense = Expense.fromSnapshot({ ...Expense.register(draft(), members, now).data!.toSnapshot(), version: 1 });
    expect(expense.delete(members, now).isSuccess()).toBe(true);
    expect(expense.pullDomainEvents().map(event => event.constructor.name)).toEqual(['ExpenseDeletedEvent']);
  });
});

describe('Expense.fromSnapshot', () => {
  it('keeps the shares as stored and the version it is at, and records nothing', () => {
    const snapshot = { ...Expense.register(draft(), members, now).data!.toSnapshot(), version: 3 };
    const expense = Expense.fromSnapshot(snapshot);
    expect(expense.toSnapshot()).toEqual(snapshot);
    expect(expense.pullDomainEvents()).toEqual([]);
  });

  it('throws on shares that do not add up to the amount', () => {
    const snapshot = { ...Expense.register(draft(), members, now).data!.toSnapshot(), version: 1 };
    expect(() => Expense.fromSnapshot({ ...snapshot, amount: 999 })).toThrow();
  });
});

describe('Expense in another currency (request 21)', () => {
  const loaded = () =>
    Expense.fromSnapshot({ ...Expense.register(draft(), members, now).data!.toSnapshot(), version: 1 });
  const edit: EditDraft = {
    groupCurrency: 'EUR',
    description: 'Dinner',
    amount: 900,
    date: '2026-11-16',
    split: { kind: 'equal', memberIds: ['ann', 'bob'] },
  };
  const inChf = (overrides: Partial<ExpenseDraft> = {}): ExpenseDraft =>
    draft({
      amount: undefined,
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      ...overrides,
    });

  it('converts the original at its rate, and keeps the currency, the amount and the rate as given', () => {
    const expense = Expense.register(inChf(), members, now);
    expect(expense.isFailure()).toBe(false);
    const snapshot = expense.data!.toSnapshot();
    expect(snapshot.amount).toBe(1311);
    expect(snapshot.original).toEqual({ currency: 'CHF', amount: 1234, rate: '1.0625' });
    expect(snapshot.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1311);
  });

  it('keeps no original for an expense in the group’s currency', () => {
    expect(Expense.register(draft(), members, now).data!.toSnapshot()).not.toHaveProperty('original');
  });

  it('refuses both an amount and an original, and neither, as an invalid amount', () => {
    expect(
      Expense.register(draft({ original: { currency: 'CHF', amount: 1, rate: '1' } }), members, now).error?.type,
    ).toBe('InvalidExpenseAmount');
    expect(Expense.register(draft({ amount: undefined }), members, now).error?.type).toBe('InvalidExpenseAmount');
  });

  it('refuses a converted amount outside 1 to 100 000 000, as any amount is refused', () => {
    expect(
      Expense.register(inChf({ original: { currency: 'CHF', amount: 1, rate: '0.1' } }), members, now).error?.type,
    ).toBe('InvalidExpenseAmount');
    expect(
      Expense.register(inChf({ original: { currency: 'CHF', amount: 100_000_000, rate: '2' } }), members, now).error
        ?.type,
    ).toBe('InvalidExpenseAmount');
  });

  it('refuses a currency that is not Tally’s, or the group’s own, and an original that is not a positive rate', () => {
    expect(
      Expense.register(inChf({ original: { currency: 'JPY', amount: 1, rate: '1' } }), members, now).error?.type,
    ).toBe('InvalidOriginalCurrency');
    expect(
      Expense.register(
        inChf({ groupCurrency: 'CHF', original: { currency: 'CHF', amount: 1, rate: '1' } }),
        members,
        now,
      ).error?.type,
    ).toBe('OriginalCurrencyIsGroupCurrency');
    expect(
      Expense.register(inChf({ original: { currency: 'CHF', amount: 0, rate: '1' } }), members, now).error?.type,
    ).toBe('InvalidOriginalAmount');
    for (const rate of ['0', '0.000', '1.1234567', '.5', '1.', '-1']) {
      expect(
        Expense.register(inChf({ original: { currency: 'CHF', amount: 1, rate } }), members, now).error?.type,
      ).toBe('InvalidOriginalRate');
    }
  });

  it('an edit with an amount is in the group’s currency, and an edit with an original is at its rate', () => {
    const expense = loaded();
    expect(
      expense
        .edit(
          { ...edit, amount: undefined, original: { currency: 'USD', amount: 1000, rate: '0.9545' } },
          members,
          1,
          now,
        )
        .isFailure(),
    ).toBe(false);
    expect(expense.toSnapshot()).toMatchObject({
      amount: 955,
      original: { currency: 'USD', amount: 1000, rate: '0.9545' },
    });

    expect(expense.edit({ ...edit, amount: 900 }, members, 1, now).isFailure()).toBe(false);
    expect(expense.toSnapshot().original).toBeUndefined();
    expect(expense.toSnapshot().amount).toBe(900);
  });

  it('is refused when the snapshot it is kept from disagrees with its amount', () => {
    const snapshot = { ...Expense.register(inChf(), members, now).data!.toSnapshot(), version: 1 };
    expect(() => Expense.fromSnapshot({ ...snapshot, amount: 1312 })).toThrow();
    expect(Expense.fromSnapshot(snapshot).toSnapshot()).toMatchObject({ amount: 1311, original: snapshot.original });
  });
});
