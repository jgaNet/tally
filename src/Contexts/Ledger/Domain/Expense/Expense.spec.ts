import { Id } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split, SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

const now = new Date('2026-03-10T10:00:00.000Z');
const [alice, bob, carl] = ['alice', 'bob', 'carl'].map(id => new Id(id));
const group = new Id('flat');
const equally = (members: string[]): SplitInput => ({ kind: 'equal', members });

const recordExpense = (overrides: Partial<Parameters<typeof Expense.create>[0]> = {}) =>
  Expense.create({
    groupId: group,
    paidBy: alice,
    description: 'Groceries',
    amount: 1000,
    date: '2026-03-10',
    split: equally(['alice', 'bob', 'carl']),
    groupMembers: [alice, bob, carl],
    now,
    ...overrides,
  });

const sharesOf = (split: ReturnType<typeof Split.equally>): Split => split.data as Split;
const amountsOf = (expense: Expense) => expense.shares.map(share => [share.memberId.value, share.amount]);

describe('Split, equally', () => {
  it('gives each member the amount divided by their number, rounded down, the remainder whole to the payer', () => {
    const split = Split.equally({
      amount: Amount.create(1000).data as Amount,
      payer: alice,
      members: [alice, bob, carl],
    });

    expect(sharesOf(split).shares.map(share => share.amount)).toEqual([334, 333, 333]);
    expect(sharesOf(split).kind).toBe('equal');
  });

  it('keeps the shares in the order the split was given', () => {
    const split = Split.equally({
      amount: Amount.create(1000).data as Amount,
      payer: alice,
      members: [bob, alice, carl],
    });

    expect(sharesOf(split).shares.map(share => share.memberId.value)).toEqual(['bob', 'alice', 'carl']);
  });

  it('adds up exactly to the amount, for any number of members and any amount', () => {
    for (const amount of [1, 2, 7, 100, 999, 12345, 100_000_000]) {
      for (const count of [1, 2, 3, 4, 7]) {
        const members = Array.from({ length: count }, (_, index) => new Id(`m${index}`));
        const split = Split.equally({ amount: Amount.create(amount).data as Amount, payer: members[0], members });

        const total = sharesOf(split).shares.reduce((sum, share) => sum + share.amount, 0);
        expect(total).toBe(amount);
      }
    }
  });
});

describe('Split, by exact amounts', () => {
  const exactly = (amounts: [Id, number][], amount = 1000) =>
    Split.exactly({
      amount: Amount.create(amount).data as Amount,
      payer: alice,
      amounts: amounts.map(([memberId, value]) => ({ memberId, amount: value })),
    });

  it('gives each member the amount they were given, in the order given', () => {
    const split = exactly([
      [bob, 250],
      [alice, 750],
    ]);

    expect(sharesOf(split).kind).toBe('exact');
    expect(sharesOf(split).shares).toEqual([
      { memberId: bob, amount: 250 },
      { memberId: alice, amount: 750 },
    ]);
  });

  it('accepts 0 for a member, the payer included', () => {
    expect(
      exactly([
        [alice, 0],
        [bob, 1000],
      ]).isSuccess(),
    ).toBe(true);
  });

  it('refuses amounts that do not add up to the amount, exactly', () => {
    expect(
      exactly([
        [alice, 400],
        [bob, 500],
      ]),
    ).toMatchObject({ error: { type: 'ShareAmountsDoNotAddUp' } });
    expect(
      exactly([
        [alice, 600],
        [bob, 401],
      ]),
    ).toMatchObject({ error: { type: 'ShareAmountsDoNotAddUp' } });
  });

  it('refuses an amount below 0, or one that is not whole', () => {
    expect(
      exactly([
        [alice, 1100],
        [bob, -100],
      ]),
    ).toMatchObject({ error: { type: 'InvalidShareAmount' } });
    expect(
      exactly([
        [alice, 500.5],
        [bob, 499.5],
      ]),
    ).toMatchObject({ error: { type: 'InvalidShareAmount' } });
  });

  it('refuses a member listed twice, and a split that leaves the payer out, as an equal split does', () => {
    expect(
      exactly([
        [alice, 500],
        [alice, 500],
      ]),
    ).toMatchObject({ error: { type: 'DuplicateSplitMember' } });
    expect(exactly([[bob, 1000]])).toMatchObject({ error: { type: 'PayerNotInSplit' } });
  });
});

describe('Split, by shares', () => {
  const byShares = (shares: [Id, number][], amount = 1000, payer = alice) =>
    Split.byShares({
      amount: Amount.create(amount).data as Amount,
      payer,
      shares: shares.map(([memberId, value]) => ({ memberId, shares: value })),
    });

  it('is the equal split when every member has one share', () => {
    const split = byShares([
      [alice, 1],
      [bob, 1],
      [carl, 1],
    ]);

    expect(sharesOf(split).kind).toBe('shares');
    expect(sharesOf(split).shares.map(share => share.amount)).toEqual([334, 333, 333]);
  });

  it('gives each member the amount times their shares, divided by the total of the shares, rounded down', () => {
    // 1001 by 2, 1 and 1: 2/4 of 1001 is 500.5, 1/4 is 250.25; both rounded down, the remainder to the payer.
    const split = byShares(
      [
        [bob, 2],
        [alice, 1],
        [carl, 1],
      ],
      1001,
    );

    const amounts = sharesOf(split).shares.map(share => share.amount);
    expect(amounts).toEqual([500, 251, 250]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(1001);
  });

  it('gives 667 and 334 for 1001 by shares of 2 and 1, the payer listed second, as the request says', () => {
    const split = byShares(
      [
        [alice, 2],
        [bob, 1],
      ],
      1001,
      bob,
    );

    expect(sharesOf(split).shares.map(share => [share.memberId.value, share.amount])).toEqual([
      ['alice', 667],
      ['bob', 334],
    ]);
  });

  it('keeps the shares in the order given, and adds up exactly to the amount, for any shares and any amount', () => {
    for (const amount of [1, 2, 7, 999, 12345, 100_000_000]) {
      for (const weights of [[1], [3, 1], [1, 2, 3], [5, 5, 1, 9], [7, 11, 13, 17, 19]]) {
        const members = weights.map((_, index) => new Id(`m${index}`));
        const split = byShares(
          weights.map((weight, index) => [members[index], weight] as [Id, number]),
          amount,
          members[members.length - 1],
        );

        expect(sharesOf(split).shares.map(share => share.memberId.value)).toEqual(members.map(m => m.value));
        const total = sharesOf(split).shares.reduce((sum, share) => sum + share.amount, 0);
        expect(total).toBe(amount);
      }
    }
  });

  it('is exact for large amounts and share counts, where a float product would not be', () => {
    const split = byShares(
      [
        [alice, 999_999_999_999],
        [bob, 1],
      ],
      100_000_000,
      alice,
    );

    const amounts = sharesOf(split).shares.map(share => share.amount);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(100_000_000);
    expect(amounts[1]).toBe(0);
  });

  it('refuses a member with fewer than 1 share, or a count that is not whole', () => {
    expect(
      byShares([
        [alice, 1],
        [bob, 0],
      ]),
    ).toMatchObject({ error: { type: 'InvalidShareCount' } });
    expect(
      byShares([
        [alice, 1],
        [bob, 1.5],
      ]),
    ).toMatchObject({ error: { type: 'InvalidShareCount' } });
  });

  it('refuses a member listed twice, and a split that leaves the payer out', () => {
    expect(
      byShares([
        [alice, 1],
        [alice, 2],
      ]),
    ).toMatchObject({ error: { type: 'DuplicateSplitMember' } });
    expect(byShares([[bob, 2]])).toMatchObject({ error: { type: 'PayerNotInSplit' } });
  });
});

describe('Expense', () => {
  it('records what the payer paid, split equally, and says so in its event', () => {
    const expense = recordExpense();

    expect(expense.isSuccess()).toBe(true);
    const recorded = (expense.data as Expense).pullDomainEvents();
    expect(recorded).toEqual([
      ExpenseRecordedEvent.set({ expenseId: (expense.data as Expense)._id.value, groupId: 'flat', splitKind: 'equal' }),
    ]);
    expect((expense.data as Expense).toSnapshot()).toEqual({
      id: (expense.data as Expense)._id.value,
      groupId: 'flat',
      description: 'Groceries',
      amount: 1000,
      date: '2026-03-10',
      paidBy: 'alice',
      splitKind: 'equal',
      shares: [
        { memberId: 'alice', amount: 334 },
        { memberId: 'bob', amount: 333 },
        { memberId: 'carl', amount: 333 },
      ],
      version: 0,
    });
  });

  it('records an expense split by exact amounts or by shares, and says how it was split in its event', () => {
    const exact = recordExpense({
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'alice', amount: 600 },
          { memberId: 'bob', amount: 400 },
        ],
      },
    }).data as Expense;
    const shares = recordExpense({
      amount: 1001,
      paidBy: bob,
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'alice', shares: 2 },
          { memberId: 'bob', shares: 1 },
        ],
      },
    }).data as Expense;

    expect(exact.splitKind).toBe('exact');
    expect(amountsOf(exact)).toEqual([
      ['alice', 600],
      ['bob', 400],
    ]);
    expect(exact.pullDomainEvents()).toEqual([
      ExpenseRecordedEvent.set({ expenseId: exact._id.value, groupId: 'flat', splitKind: 'exact' }),
    ]);
    expect(shares.splitKind).toBe('shares');
    expect(amountsOf(shares)).toEqual([
      ['alice', 667],
      ['bob', 334],
    ]);
  });

  it('is born with an id of its own, and reads back the same from its snapshot, whichever way it was split', () => {
    const equal = recordExpense().data as Expense;
    const exact = recordExpense({
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'alice', amount: 1000 },
          { memberId: 'bob', amount: 0 },
        ],
      },
    }).data as Expense;

    expect(Expense.fromSnapshot(equal.toSnapshot()).toSnapshot()).toEqual(equal.toSnapshot());
    expect(Expense.fromSnapshot(exact.toSnapshot()).toSnapshot()).toEqual(exact.toSnapshot());
  });

  it('refuses a snapshot that names no split kind it knows', () => {
    const snapshot = { ...(recordExpense().data as Expense).toSnapshot(), splitKind: 'unknown' as 'equal' };

    expect(() => Expense.fromSnapshot(snapshot)).toThrow('is corrupted');
  });

  it('refuses a split with someone who is not a current member, the payer included, whichever way it was split', () => {
    const stranger = recordExpense({ split: equally(['alice', 'stranger']) });
    const notPaying = recordExpense({ paidBy: new Id('stranger'), split: equally(['stranger']) });
    const exactStranger = recordExpense({
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'alice', amount: 500 },
          { memberId: 'stranger', amount: 500 },
        ],
      },
    });

    expect(stranger.isFailure() && stranger.error.type).toBe('NotAMemberOfTheGroup');
    expect(notPaying.isFailure() && notPaying.error.type).toBe('NotAMemberOfTheGroup');
    expect(exactStranger.isFailure() && exactStranger.error.type).toBe('NotAMemberOfTheGroup');
  });

  it('refuses a split that lists a member twice, or leaves the payer out', () => {
    expect(recordExpense({ split: equally(['alice', 'alice']) }).isFailure()).toBe(true);
    expect(recordExpense({ split: equally(['alice', 'alice']) })).toMatchObject({
      error: { type: 'DuplicateSplitMember' },
    });
    expect(recordExpense({ split: equally(['bob']) })).toMatchObject({ error: { type: 'PayerNotInSplit' } });
  });

  it('checks the day against the clock it is given: today is allowed, tomorrow is not', () => {
    expect(recordExpense({ date: '2026-03-10' }).isSuccess()).toBe(true);
    expect(recordExpense({ date: '2026-03-11' })).toMatchObject({ error: { type: 'DateInTheFuture' } });
    expect(recordExpense({ date: '2024-02-29' }).isSuccess()).toBe(true);
    expect(recordExpense({ date: '2025-02-29' })).toMatchObject({ error: { type: 'InvalidDate' } });
    expect(recordExpense({ date: '10/03/2026' })).toMatchObject({ error: { type: 'InvalidDate' } });
  });

  it('refuses a description of 0 or 101 characters, and an amount outside 1 to 100 000 000', () => {
    expect(recordExpense({ description: '' })).toMatchObject({ error: { type: 'InvalidDescription' } });
    expect(recordExpense({ description: ' \t ' })).toMatchObject({ error: { type: 'InvalidDescription' } });
    expect(recordExpense({ description: 'x'.repeat(100) }).isSuccess()).toBe(true);
    expect(recordExpense({ description: 'x'.repeat(101) })).toMatchObject({ error: { type: 'InvalidDescription' } });
    expect(recordExpense({ amount: 0 })).toMatchObject({ error: { type: 'InvalidAmount' } });
    expect(recordExpense({ amount: 1.5 })).toMatchObject({ error: { type: 'InvalidAmount' } });
    expect(recordExpense({ amount: 100_000_000 }).isSuccess()).toBe(true);
    expect(recordExpense({ amount: 100_000_001 })).toMatchObject({ error: { type: 'InvalidAmount' } });
  });
});

/** An expense as the repository would have read it back: saved once, at version 1. */
const savedExpense = (overrides: Partial<Parameters<typeof Expense.create>[0]> = {}): Expense => {
  const recorded = (recordExpense(overrides).data as Expense).toSnapshot();
  return Expense.fromSnapshot({ ...recorded, version: 1 });
};

const editing = (overrides: Partial<Parameters<Expense['edit']>[0]> = {}) => ({
  by: alice,
  byOwner: false,
  version: 1,
  description: 'Groceries, again',
  amount: 900,
  date: '2026-03-10',
  split: equally(['alice', 'bob']),
  groupMembers: [alice, bob, carl],
  now,
  ...overrides,
});

describe('Expense, edited and deleted', () => {
  it('is born at version 0, which the repository saves as 1', () => {
    expect((recordExpense().data as Expense).version).toBe(0);
    expect(savedExpense().version).toBe(1);
  });

  it('is edited whole by its payer, from the version it was read at, and the edit keeps the payer and the event', () => {
    const saved = savedExpense();
    const edited = saved.edit(editing());

    expect(edited.isSuccess()).toBe(true);
    const expense = edited.data as Expense;
    expect(expense._id.value).toBe(saved._id.value);
    expect(expense.paidBy.value).toBe('alice');
    expect(expense.version).toBe(1);
    expect(expense.shares.map(share => [share.memberId.value, share.amount])).toEqual([
      ['alice', 450],
      ['bob', 450],
    ]);
    expect(expense.pullDomainEvents()).toEqual([
      ExpenseEditedEvent.set({ expenseId: expense._id.value, groupId: 'flat', splitKind: 'equal' }),
    ]);
  });

  it('is edited into another kind of split, and the event says which one it now is', () => {
    const edited = savedExpense().edit(
      editing({
        split: {
          kind: 'shares',
          shares: [
            { memberId: 'alice', shares: 2 },
            { memberId: 'bob', shares: 1 },
          ],
        },
      }),
    );

    expect(edited.isSuccess()).toBe(true);
    const expense = edited.data as Expense;
    expect(expense.splitKind).toBe('shares');
    expect(amountsOf(expense)).toEqual([
      ['alice', 600],
      ['bob', 300],
    ]);
    expect(expense.pullDomainEvents()).toEqual([
      ExpenseEditedEvent.set({ expenseId: expense._id.value, groupId: 'flat', splitKind: 'shares' }),
    ]);
  });

  it('is edited by the owner of its group, who keeps the payer as well', () => {
    const edited = savedExpense().edit(editing({ by: carl, byOwner: true }));

    expect(edited.isSuccess()).toBe(true);
    expect((edited.data as Expense).paidBy.value).toBe('alice');
  });

  it('refuses an edit by a member who is neither the payer nor the owner', () => {
    const refused = savedExpense().edit(editing({ by: bob, byOwner: false }));

    expect(refused).toMatchObject({ error: { type: 'NotThePayerOrTheOwner' } });
  });

  it('refuses an edit made from a version the expense has since left, and names it', () => {
    const refused = savedExpense().edit(editing({ version: 0 }));

    expect(refused).toMatchObject({ error: { type: 'ExpenseChanged' } });
  });

  it('refuses an edit that gives a split with a stranger, the same as recording one', () => {
    const refused = savedExpense().edit(editing({ split: equally(['alice', 'stranger']) }));

    expect(refused).toMatchObject({ error: { type: 'NotAMemberOfTheGroup' } });
  });

  it('refuses an edit that leaves the payer out of the split', () => {
    const refused = savedExpense().edit(editing({ split: equally(['bob', 'carl']) }));

    expect(refused).toMatchObject({ error: { type: 'PayerNotInSplit' } });
  });

  it('refuses an edit whose exact amounts do not add up to its new amount', () => {
    const refused = savedExpense().edit(
      editing({
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'alice', amount: 500 },
            { memberId: 'bob', amount: 500 },
          ],
        },
      }),
    );

    expect(refused).toMatchObject({ error: { type: 'ShareAmountsDoNotAddUp' } });
  });

  it('is deleted by its payer or the owner, and records the deletion', () => {
    const saved = savedExpense();
    const deleted = saved.delete({ by: alice, byOwner: false, groupMembers: [alice, bob, carl] });

    expect(deleted.isSuccess()).toBe(true);
    expect((deleted.data as Expense).pullDomainEvents()).toEqual([
      ExpenseDeletedEvent.set({ expenseId: saved._id.value, groupId: 'flat' }),
    ]);
  });

  it('refuses a deletion by a member who is neither the payer nor the owner', () => {
    expect(savedExpense().delete({ by: bob, byOwner: false, groupMembers: [alice, bob, carl] })).toMatchObject({
      error: { type: 'NotThePayerOrTheOwner' },
    });
  });
});

describe('an expense that concerns a member who has left the group', () => {
  // Carl was in the split of this expense, and has since left: the group's members now are Alice and Bob only.
  const current = [alice, bob];
  const withCarl = () => savedExpense({ paidBy: alice, split: equally(['alice', 'bob', 'carl']) });

  it('cannot be edited, by its payer or by the owner', () => {
    expect(withCarl().edit(editing({ by: alice, byOwner: true, groupMembers: current }))).toMatchObject({
      error: { type: 'ExpenseConcernsAFormerMember' },
    });
  });

  it('cannot be deleted, by its payer or by the owner', () => {
    expect(withCarl().delete({ by: alice, byOwner: true, groupMembers: current })).toMatchObject({
      error: { type: 'ExpenseConcernsAFormerMember' },
    });
  });

  it('cannot be edited nor deleted when the one who left is its payer', () => {
    const paidByCarl = savedExpense({ paidBy: carl, split: equally(['carl', 'alice']) });

    expect(paidByCarl.edit(editing({ by: carl, byOwner: false, groupMembers: current }))).toMatchObject({
      error: { type: 'ExpenseConcernsAFormerMember' },
    });
    expect(paidByCarl.delete({ by: carl, byOwner: false, groupMembers: current })).toMatchObject({
      error: { type: 'ExpenseConcernsAFormerMember' },
    });
  });

  it('is changeable again once the one who left is a member again', () => {
    expect(
      withCarl()
        .edit(editing({ by: alice, byOwner: true, groupMembers: [alice, bob, carl] }))
        .isSuccess(),
    ).toBe(true);
  });
});
