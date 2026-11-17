import { Id } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

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
      version: 0,
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
  splitBetween: [alice, bob],
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
      ExpenseEditedEvent.set({ expenseId: expense._id.value, groupId: 'flat' }),
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
    const refused = savedExpense().edit(editing({ splitBetween: [alice, new Id('stranger')] }));

    expect(refused).toMatchObject({ error: { type: 'NotAMemberOfTheGroup' } });
  });

  it('refuses an edit that leaves the payer out of the split', () => {
    const refused = savedExpense().edit(editing({ splitBetween: [bob, carl] }));

    expect(refused).toMatchObject({ error: { type: 'PayerNotInSplit' } });
  });

  it('is deleted by its payer or the owner, and records the deletion', () => {
    const saved = savedExpense();
    const deleted = saved.delete({ by: alice, byOwner: false });

    expect(deleted.isSuccess()).toBe(true);
    expect((deleted.data as Expense).pullDomainEvents()).toEqual([
      ExpenseDeletedEvent.set({ expenseId: saved._id.value, groupId: 'flat' }),
    ]);
  });

  it('refuses a deletion by a member who is neither the payer nor the owner', () => {
    expect(savedExpense().delete({ by: bob, byOwner: false })).toMatchObject({
      error: { type: 'NotThePayerOrTheOwner' },
    });
  });
});
