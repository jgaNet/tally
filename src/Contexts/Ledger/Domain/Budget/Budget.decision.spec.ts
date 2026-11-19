import { Budget, BudgetSnapshot } from './Budget';
import { BudgetAmount } from './BudgetAmount';
import { decidePassBudget, decideRemoveBudget, decideSetBudget } from './Budget.decision';

const now = new Date('2026-11-18T10:00:00Z');
const ownerId = 'ada';

const stored = (overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
  id: 'budget-1',
  groupId: 'group-1',
  category: 'groceries',
  amount: 400,
  passedMonths: [],
  version: 1,
  ...overrides,
});

describe('setting a budget', () => {
  it('lets the owner set a category’s budget from 1 to 100 000 000', () => {
    for (const amount of [1, 400, 100_000_000]) {
      const decision = decideSetBudget(
        { archived: false, ownerId },
        { by: ownerId, category: 'groceries', amount },
        now,
      );
      expect(decision.isSuccess()).toBe(true);
      expect(decision.data!.state.amount.value).toBe(amount);
      expect(decision.data!.state.category).toBe('groceries');
    }
  });

  it('refuses any other member before looking at the values', () => {
    const decision = decideSetBudget({ archived: false, ownerId }, { by: 'grace', category: 'pets', amount: 0 }, now);
    expect(decision.isFailure()).toBe(true);
    expect(decision.error!.type).toBe('NotAllowed');
  });

  it('refuses an amount outside 1 to 100 000 000, and a category that is not one of the eight', () => {
    for (const amount of [0, -1, 100_000_001, 1.5]) {
      const decision = decideSetBudget({ archived: false, ownerId }, { by: ownerId, category: 'rent', amount }, now);
      expect(decision.error!.type).toBe('InvalidBudgetAmount');
    }
    const decision = decideSetBudget({ archived: false, ownerId }, { by: ownerId, category: 'pets', amount: 10 }, now);
    expect(decision.error!.type).toBe('InvalidExpenseCategory');
  });
});

describe('removing a budget', () => {
  it('lets the owner remove a budget that has an amount', () => {
    const decision = decideRemoveBudget(
      { archived: false, ownerId, budget: stored() },
      { by: ownerId, category: 'groceries' },
      now,
    );
    expect(decision.data!.state).toBe('groceries');
  });

  it('refuses any other member, and finds nothing to remove where there is no budget or it was removed', () => {
    expect(
      decideRemoveBudget({ archived: false, ownerId, budget: stored() }, { by: 'grace', category: 'groceries' }, now)
        .error!.type,
    ).toBe('NotAllowed');
    expect(
      decideRemoveBudget({ archived: false, ownerId, budget: undefined }, { by: ownerId, category: 'rent' }, now).error!
        .type,
    ).toBe('NotFound');
    expect(
      decideRemoveBudget(
        { archived: false, ownerId, budget: stored({ amount: undefined }) },
        { by: ownerId, category: 'groceries' },
        now,
      ).error!.type,
    ).toBe('NotFound');
  });
});

describe('passing a budget', () => {
  const given = { spent: 401, memberIds: ['ada', 'grace'] };

  it('passes it when the month spends more than the budget, with the members to tell', () => {
    const decision = decidePassBudget({ ...given, budget: stored() }, { month: '2026-11' }, now);
    expect(decision.data!.state).toEqual({ kind: 'passed', month: '2026-11', spent: 401, memberIds: ['ada', 'grace'] });
  });

  it('passes nothing at the budget, under it, with no budget, or with a budget that was removed', () => {
    for (const [spent, budget] of [
      [400, stored()],
      [10, stored()],
      [999, undefined],
      [999, stored({ amount: undefined })],
    ] as const) {
      const decision = decidePassBudget({ ...given, spent, budget }, { month: '2026-11' }, now);
      expect(decision.data!.state).toEqual({ kind: 'nothing' });
    }
  });

  it('passes it once for a month, and again for another', () => {
    const budget = stored({ passedMonths: ['2026-11'] });
    expect(decidePassBudget({ ...given, budget }, { month: '2026-11' }, now).data!.state).toEqual({ kind: 'nothing' });
    expect(decidePassBudget({ ...given, budget }, { month: '2026-10' }, now).data!.state.kind).toBe('passed');
  });
});

describe('the budget', () => {
  const amount = (value: number) => BudgetAmount.create(value).data!;

  it('records BudgetSet when it is set, and again when it is replaced, and BudgetRemoved when it is removed', () => {
    const budget = Budget.create({
      groupId: 'group-1',
      category: 'rent',
      amount: amount(100),
      at: new Date('2026-11-01T00:00:00Z'),
    });
    budget.setAmount(amount(200), new Date('2026-11-02T00:00:00Z'));
    budget.retire();
    expect(budget.pullDomainEvents().map(event => event.name)).toEqual([
      'BudgetSetEvent',
      'BudgetSetEvent',
      'BudgetRemovedEvent',
    ]);
    expect(budget.toSnapshot()).toMatchObject({ amount: undefined, passedMonths: [] });
  });

  it('records BudgetPassed once for a month, keeping the month even when it is removed and set again', () => {
    const budget = Budget.fromSnapshot(stored());
    budget.pass({ month: '2026-11', spent: 500, memberIds: ['ada'] });
    expect(budget.pullDomainEvents().map(event => event.name)).toEqual(['BudgetPassedEvent']);
    expect(() => budget.pass({ month: '2026-11', spent: 600, memberIds: ['ada'] })).toThrow();
    budget.retire();
    budget.setAmount(amount(400), new Date('2026-11-03T00:00:00Z'));
    expect(budget.toSnapshot().passedMonths).toEqual(['2026-11']);
  });

  it('records nothing when it is rebuilt, and throws on data it could not have made', () => {
    const budget = Budget.fromSnapshot(stored());
    expect(budget.pullDomainEvents()).toEqual([]);
    expect(() => Budget.fromSnapshot(stored({ amount: 0 }))).toThrow();
  });
});
