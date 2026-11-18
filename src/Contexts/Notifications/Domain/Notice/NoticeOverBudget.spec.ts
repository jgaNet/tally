import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { Id } from '@Architecture/Domain';

describe('Notice.overBudget', () => {
  const made = (budget: number, spent: number) =>
    Notice.overBudget({
      recipient: new Id('ann'),
      groupId: new Id('flat'),
      category: 'groceries',
      month: '2026-11',
      budget,
      spent,
      now: new Date('2026-11-18T09:00:00.000Z'),
    });

  it('names the category, the month, the budget and what the month spent, and no expense', () => {
    const notice = made(400, 401).data as Notice;

    expect(notice.kind).toBe('budget');
    expect(notice.expenseId).toBeNull();
    expect(notice.amount).toBe(401);
    expect(notice.budgetPassed).toEqual({ category: 'groceries', month: '2026-11', budget: 400 });
  });

  it('is for a month that spent more than the budget, which is at least 1', () => {
    expect(made(400, 400).isFailure()).toBe(true);
    expect(made(0, 5).isFailure()).toBe(true);
    expect(made(400, 400.5).isFailure()).toBe(true);
  });
});
