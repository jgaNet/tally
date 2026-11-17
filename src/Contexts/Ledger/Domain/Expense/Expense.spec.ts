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
