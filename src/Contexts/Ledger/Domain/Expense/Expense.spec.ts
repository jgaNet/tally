import { Id } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

const NOW = new Date('2026-05-10T12:00:00.000Z');
const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(value => new Id(value));

const amount = (value: number) => Amount.create(value).data!;
const split = (value: number, payer: Id, between: Id[]) =>
  Split.equally({ amount: amount(value), payer, between }).data!;

describe('Description', () => {
  it('accepts 1 to 100 characters, and refuses none and only spaces', () => {
    expect(Description.create('a').isFailure()).toBe(false);
    expect(Description.create('a'.repeat(100)).isFailure()).toBe(false);
    expect(Description.create('').isFailure()).toBe(true);
    expect(Description.create('   ').isFailure()).toBe(true);
    expect(Description.create('a'.repeat(101)).isFailure()).toBe(true);
  });
});

describe('Amount', () => {
  it('accepts whole numbers from 1 to 100 000 000', () => {
    expect(Amount.create(1).isFailure()).toBe(false);
    expect(Amount.create(100_000_000).isFailure()).toBe(false);
    expect(Amount.create(0).isFailure()).toBe(true);
    expect(Amount.create(100_000_001).isFailure()).toBe(true);
    expect(Amount.create(10.5).isFailure()).toBe(true);
  });
});

describe('ExpenseDate', () => {
  it('accepts a real day, not after today in UTC', () => {
    expect(ExpenseDate.create('2026-05-10', NOW).isFailure()).toBe(false);
    expect(ExpenseDate.create('2026-05-09', NOW).isFailure()).toBe(false);
    expect(ExpenseDate.create('2026-05-11', NOW).error?.type).toBe('DateInTheFuture');
  });

  it('refuses a day that is not in the calendar, or not written as one', () => {
    expect(ExpenseDate.create('2026-02-29', NOW).error?.type).toBe('InvalidDate');
    expect(ExpenseDate.create('2026-2-3', NOW).error?.type).toBe('InvalidDate');
    expect(ExpenseDate.create('10/05/2026', NOW).error?.type).toBe('InvalidDate');
  });
});

describe('Split', () => {
  it('divides the amount equally, rounded down, the remainder whole to the payer', () => {
    const s = split(1000, alice, [bob, carol, alice]);
    expect(s.shares.map(share => share.amount)).toEqual([333, 333, 334]);
    expect(s.shares.map(share => share.memberId.value)).toEqual(['bob', 'carol', 'alice']);
  });

  it('never loses a unit: the shares add up to the amount', () => {
    for (const value of [1, 2, 7, 99, 100, 101, 1000, 99_999_999, 100_000_000]) {
      for (const members of [[alice], [alice, bob], [alice, bob, carol]]) {
        const shares = split(value, alice, members).shares;
        expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(value);
      }
    }
  });

  it('refuses a split without its payer, and a member listed twice', () => {
    expect(Split.equally({ amount: amount(10), payer: alice, between: [bob] }).error?.type).toBe('PayerNotInSplit');
    expect(Split.equally({ amount: amount(10), payer: alice, between: [] }).error?.type).toBe('PayerNotInSplit');
    expect(Split.equally({ amount: amount(10), payer: alice, between: [alice, alice] }).error?.type).toBe(
      'MemberListedTwice',
    );
  });

  it('is equal to the same split, and not to another', () => {
    expect(split(10, alice, [alice, bob]).equals(split(10, alice, [alice, bob]))).toBe(true);
    expect(split(10, alice, [alice, bob]).equals(split(10, alice, [bob, alice]))).toBe(false);
  });
});

describe('Split by exact amounts', () => {
  const exact = (value: number, payer: Id, amounts: [Id, number][]) =>
    Split.exactly({
      amount: amount(value),
      payer,
      amounts: amounts.map(([memberId, share]) => ({ memberId, amount: share })),
    });

  it('gives each member the amount of their share, in the order given', () => {
    const s = exact(10, alice, [
      [bob, 7],
      [alice, 3],
    ]).data!;
    expect(s.kind).toBe('exact');
    expect(s.shares.map(share => [share.memberId.value, share.amount])).toEqual([
      ['bob', 7],
      ['alice', 3],
    ]);
  });

  it('accepts an amount of 0, the payer among them', () => {
    expect(
      exact(10, alice, [
        [alice, 0],
        [bob, 10],
      ]).isFailure(),
    ).toBe(false);
  });

  it('refuses amounts that do not add up to the amount of the expense, exactly', () => {
    expect(
      exact(10, alice, [
        [alice, 3],
        [bob, 6],
      ]).error?.type,
    ).toBe('ExactAmountsDoNotAddUp');
    expect(
      exact(10, alice, [
        [alice, 5],
        [bob, 6],
      ]).error?.type,
    ).toBe('ExactAmountsDoNotAddUp');
  });

  it('refuses an amount below 0, or not a whole number of units', () => {
    expect(
      exact(10, alice, [
        [alice, -1],
        [bob, 11],
      ]).error?.type,
    ).toBe('InvalidExactAmount');
    expect(
      exact(10, alice, [
        [alice, 5.5],
        [bob, 4.5],
      ]).error?.type,
    ).toBe('InvalidExactAmount');
  });

  it('refuses a split without its payer, and a member listed twice', () => {
    expect(exact(10, alice, [[bob, 10]]).error?.type).toBe('PayerNotInSplit');
    expect(exact(10, alice, []).error?.type).toBe('PayerNotInSplit');
    expect(
      exact(10, alice, [
        [bob, 5],
        [bob, 5],
      ]).error?.type,
    ).toBe('MemberListedTwice');
  });
});

describe('Split by shares', () => {
  const shares = (value: number, payer: Id, parts: [Id, number][]) =>
    Split.byShares({
      amount: amount(value),
      payer,
      shares: parts.map(([memberId, count]) => ({ memberId, shares: count })),
    });

  it('divides by the shares, rounded down, the remainder whole to the payer', () => {
    // 1001 by 2 and 1 shares, the payer (alice) listed second: 667 for bob, 333 + the remainder 1 for alice.
    const s = shares(1001, alice, [
      [bob, 2],
      [alice, 1],
    ]).data!;
    expect(s.kind).toBe('shares');
    expect(s.shares.map(share => share.amount)).toEqual([667, 334]);
  });

  it('is the equal split when every member has one share', () => {
    const byOne = shares(1000, alice, [
      [bob, 1],
      [carol, 1],
      [alice, 1],
    ]).data!;
    expect(byOne.shares.map(share => share.amount)).toEqual(
      split(1000, alice, [bob, carol, alice]).shares.map(s => s.amount),
    );
  });

  it('never loses a unit: the shares add up to the amount, whatever the shares', () => {
    for (const value of [1, 7, 100, 1001, 99_999_999, 100_000_000]) {
      for (const counts of [
        [1, 2, 3],
        [5, 1],
        [7, 7, 7, 7],
        [1, 1000],
      ]) {
        const parts: [Id, number][] = counts.map((count, index) => [new Id(`m${index}`), count]);
        const result = shares(value, parts[0][0], parts).data!;
        expect(result.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(value);
      }
    }
  });

  it('refuses a member with less than one share, or a share that is not a whole number', () => {
    expect(
      shares(10, alice, [
        [alice, 0],
        [bob, 1],
      ]).error?.type,
    ).toBe('InvalidShares');
    expect(
      shares(10, alice, [
        [alice, 1],
        [bob, 1.5],
      ]).error?.type,
    ).toBe('InvalidShares');
  });

  it('refuses a split without its payer, and a member listed twice', () => {
    expect(shares(10, alice, [[bob, 1]]).error?.type).toBe('PayerNotInSplit');
    expect(
      shares(10, alice, [
        [alice, 1],
        [alice, 2],
      ]).error?.type,
    ).toBe('MemberListedTwice');
  });
});

describe('Split from a request', () => {
  it('takes the one of the three kinds the request names', () => {
    const between = Split.fromRequest({
      amount: amount(10),
      payer: alice,
      request: { splitBetween: ['alice', 'bob'] },
    });
    expect(between.data!.kind).toBe('equal');
    const exact = Split.fromRequest({
      amount: amount(10),
      payer: alice,
      request: {
        splitExactly: [
          { memberId: 'alice', amount: 4 },
          { memberId: 'bob', amount: 6 },
        ],
      },
    });
    expect(exact.data!.kind).toBe('exact');
    const byShares = Split.fromRequest({
      amount: amount(10),
      payer: alice,
      request: { splitByShares: [{ memberId: 'alice', shares: 1 }] },
    });
    expect(byShares.data!.kind).toBe('shares');
  });

  it('refuses none of the three, or more than one, by name', () => {
    expect(Split.fromRequest({ amount: amount(10), payer: alice, request: {} }).error?.type).toBe('OneSplitOnly');
    expect(
      Split.fromRequest({
        amount: amount(10),
        payer: alice,
        request: { splitBetween: ['alice'], splitByShares: [{ memberId: 'alice', shares: 1 }] },
      }).error?.type,
    ).toBe('OneSplitOnly');
  });
});

describe('the kind of a split', () => {
  it('is kept as it was stored, and told apart from another kind of the same shares', () => {
    const stored = Split.fromSnapshot({
      kind: 'shares',
      payer: 'alice',
      amount: 10,
      shares: [
        { memberId: 'alice', amount: 5 },
        { memberId: 'bob', amount: 5 },
      ],
    });
    expect(stored.kind).toBe('shares');
    const equal = split(10, alice, [alice, bob]);
    expect(stored.equals(equal)).toBe(false);
  });

  it('is refused when the stored kind is none of the three', () => {
    expect(() =>
      Split.fromSnapshot({
        kind: 'lottery' as never,
        payer: 'alice',
        amount: 1,
        shares: [{ memberId: 'alice', amount: 1 }],
      }),
    ).toThrow();
  });
});

describe('Expense', () => {
  const create = (members: Id[], between: Id[] = [alice, bob]) =>
    Expense.create({
      groupId: new Id('group'),
      description: Description.create('Groceries').data!,
      amount: amount(10),
      date: ExpenseDate.create('2026-05-10', NOW).data!,
      split: split(10, alice, between),
      groupMembers: members,
      at: NOW,
    });

  it('records ExpenseRecorded, and keeps the split as it was decided', () => {
    const expense = create([alice, bob, carol]).data!;
    expect(expense.pullDomainEvents()).toHaveLength(1);
    expect(expense.toSnapshot()).toMatchObject({
      groupId: 'group',
      paidBy: 'alice',
      shares: [
        { memberId: 'alice', amount: 5 },
        { memberId: 'bob', amount: 5 },
      ],
      version: 0,
    });
  });

  it('refuses a split with someone who is not a current member', () => {
    expect(create([alice]).error?.type).toBe('NotAGroupMember');
    expect(create([]).error?.type).toBe('NotAGroupMember');
  });

  it('is rebuilt from its snapshot, which records nothing', () => {
    const expense = create([alice, bob]).data!;
    const rebuilt = Expense.fromSnapshot({ ...expense.toSnapshot(), version: 3 });
    expect(rebuilt.pullDomainEvents()).toHaveLength(0);
    expect(rebuilt.toSnapshot()).toEqual({ ...expense.toSnapshot(), version: 3 });
  });

  it('refuses corrupted data when rebuilt', () => {
    const snapshot = create([alice, bob]).data!.toSnapshot();
    expect(() => Expense.fromSnapshot({ ...snapshot, shares: [{ memberId: 'alice', amount: 4 }] })).toThrow();
  });
});
