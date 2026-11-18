import { Id } from '@Architecture/Domain';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { BudgetNotSet, NotTheOwnerOfTheGroup } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { InvalidAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

const group = new Id('flat');
const members = [new Id('ann'), new Id('ben')];
const set = (amount = 400) =>
  Budget.set({ groupId: group, category: 'groceries', amount, byOwner: true }).data as Budget;

describe('Budget', () => {
  it('is set by the owner, under an id it generates, and records that it was set', () => {
    const budget = set();

    expect(budget._id.value).toEqual(expect.any(String));
    expect(budget.toSnapshot()).toMatchObject({ groupId: 'flat', category: 'groceries', amount: 400, version: 0 });
    expect(budget.pullDomainEvents()).toEqual([
      BudgetSetEvent.set({ budgetId: budget._id.value, groupId: 'flat', category: 'groceries', amount: 400 }),
    ]);
  });

  it('is refused to a member who is not the owner, and with an amount outside 1 to 100 000 000', () => {
    expect(Budget.set({ groupId: group, category: 'rent', amount: 1, byOwner: false }).error).toBeInstanceOf(
      NotTheOwnerOfTheGroup,
    );
    for (const amount of [0, -1, 1.5, 100_000_001]) {
      expect(Budget.set({ groupId: group, category: 'rent', amount, byOwner: true }).error).toBeInstanceOf(
        InvalidAmount,
      );
    }
    expect(Budget.set({ groupId: group, category: 'rent', amount: 100_000_000, byOwner: true }).isSuccess()).toBe(true);
  });

  it('is replaced by setting it again, by the owner only, keeping its id', () => {
    const budget = set();
    const replaced = budget.replace({ amount: 500, byOwner: true }).data as Budget;

    expect(replaced._id.value).toBe(budget._id.value);
    expect(replaced.amount.value).toBe(500);
    expect(budget.replace({ amount: 500, byOwner: false }).error).toBeInstanceOf(NotTheOwnerOfTheGroup);
    expect(budget.replace({ amount: 0, byOwner: true }).error).toBeInstanceOf(InvalidAmount);
  });

  it('is removed by the owner only, once', () => {
    const budget = set();
    expect(budget.unset({ byOwner: false }).error).toBeInstanceOf(NotTheOwnerOfTheGroup);

    const removed = budget.unset({ byOwner: true }).data as Budget;
    expect(removed.removed).toBe(true);
    expect(removed.pullDomainEvents()).toEqual([
      BudgetRemovedEvent.set({ budgetId: budget._id.value, groupId: 'flat', category: 'groceries' }),
    ]);
    expect(removed.unset({ byOwner: true }).error).toBeInstanceOf(BudgetNotSet);
  });

  it('is passed when a month spends more than it, for the first time, and tells the members', () => {
    const budget = set();
    budget.pullDomainEvents();

    expect(budget.pass({ month: '2026-11', spent: 400, members })).toBe(budget);

    const passed = budget.pass({ month: '2026-11', spent: 401, members });
    expect(passed).not.toBe(budget);
    expect(passed.pullDomainEvents()).toEqual([
      BudgetPassedEvent.set({
        budgetId: budget._id.value,
        groupId: 'flat',
        category: 'groceries',
        month: '2026-11',
        budget: 400,
        spent: 401,
        members: ['ann', 'ben'],
      }),
    ]);
  });

  it('is passed once a month: further over, or over again, records nothing, and another month is another fact', () => {
    const passed = set().pass({ month: '2026-11', spent: 401, members });

    expect(passed.pass({ month: '2026-11', spent: 900, members })).toBe(passed);
    const next = passed.pass({ month: '2026-12', spent: 401, members });
    expect(next).not.toBe(passed);
    expect(next.toSnapshot().passedMonths).toEqual(['2026-11', '2026-12']);
  });

  it('remembers the months it was passed in when it is removed and set again, and is passed by none while removed', () => {
    const passed = set().pass({ month: '2026-11', spent: 401, members });
    const removed = passed.unset({ byOwner: true }).data as Budget;
    expect(removed.pass({ month: '2026-12', spent: 999, members })).toBe(removed);

    const again = removed.replace({ amount: 100, byOwner: true }).data as Budget;
    expect(again.pass({ month: '2026-11', spent: 999, members })).toBe(again);
    expect(again.pass({ month: '2026-12', spent: 999, members })).not.toBe(again);
  });

  it('is rebuilt from its snapshot without recording anything', () => {
    const snapshot = set().pass({ month: '2026-11', spent: 401, members }).toSnapshot();
    const rebuilt = Budget.fromSnapshot({ ...snapshot, version: 3 });

    expect(rebuilt.pullDomainEvents()).toEqual([]);
    expect(rebuilt.toSnapshot()).toEqual({ ...snapshot, version: 3 });
    expect(() => Budget.fromSnapshot({ ...snapshot, amount: 0 })).toThrow();
    expect(() => Budget.fromSnapshot({ ...snapshot, category: 'pets' })).toThrow();
  });
});
