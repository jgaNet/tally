import { Id } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

const now = new Date('2026-03-10T10:00:00.000Z');
const [alice, bob, carl] = ['alice', 'bob', 'carl'].map(id => new Id(id));
const group = new Id('flat');

const recordExpense = (overrides: Partial<Parameters<typeof Expense.create>[0]> = {}) =>
  Expense.create({
    groupId: group,
    paidBy: alice,
    description: 'Groceries',
    amount: 1000,
    date: '2026-03-10',
    splitBetween: [alice, bob, carl],
    groupMembers: [alice, bob, carl],
    now,
    ...overrides,
  });

const sharesOf = (split: ReturnType<typeof Split.equally>): Split => split.data as Split;

describe('Split, equally', () => {
  it('gives each member the amount divided by their number, rounded down, the remainder whole to the payer', () => {
    const split = Split.equally({
      amount: Amount.create(1000).data as Amount,
      payer: alice,
      members: [alice, bob, carl],
    });

    expect(sharesOf(split).shares.map(share => share.amount)).toEqual([334, 333, 333]);
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

describe('Expense', () => {
  it('records what the payer paid, split equally, and says so in its event', () => {
    const expense = recordExpense();

    expect(expense.isSuccess()).toBe(true);
    const recorded = (expense.data as Expense).pullDomainEvents();
    expect(recorded).toEqual([
      ExpenseRecordedEvent.set({ expenseId: (expense.data as Expense)._id.value, groupId: 'flat' }),
    ]);
    expect((expense.data as Expense).toSnapshot()).toEqual({
      id: (expense.data as Expense)._id.value,
      groupId: 'flat',
      description: 'Groceries',
      amount: 1000,
      date: '2026-03-10',
      paidBy: 'alice',
      shares: [
        { memberId: 'alice', amount: 334 },
        { memberId: 'bob', amount: 333 },
        { memberId: 'carl', amount: 333 },
      ],
    });
  });

  it('is born with an id of its own, and reads back the same from its snapshot', () => {
    const expense = recordExpense().data as Expense;

    expect(Expense.fromSnapshot(expense.toSnapshot()).toSnapshot()).toEqual(expense.toSnapshot());
  });

  it('refuses a split with someone who is not a current member, the payer included', () => {
    const stranger = recordExpense({ splitBetween: [alice, new Id('stranger')] });
    const notPaying = recordExpense({ paidBy: new Id('stranger'), splitBetween: [new Id('stranger')] });

    expect(stranger.isFailure() && stranger.error.type).toBe('NotAMemberOfTheGroup');
    expect(notPaying.isFailure() && notPaying.error.type).toBe('NotAMemberOfTheGroup');
  });

  it('refuses a split that lists a member twice, or leaves the payer out', () => {
    expect(recordExpense({ splitBetween: [alice, alice] }).isFailure()).toBe(true);
    expect(recordExpense({ splitBetween: [alice, alice] })).toMatchObject({
      error: { type: 'DuplicateSplitMember' },
    });
    expect(recordExpense({ splitBetween: [bob] })).toMatchObject({ error: { type: 'PayerNotInSplit' } });
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
