import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The decisions a budget gets when another writer saved it first (CONC-OPTIMISTIC): decided again from a fresh read, up to this many. */
const ATTEMPTS = 3;

/**
 * The policy on an expense recorded or edited (request 24): once the expense is stored, the month it is dated in, in its
 * category, is what the category's budget decides. The spending of the month is read from Ledger's own read model, the members
 * to tell are the group's current members, and the budget records BudgetPassed when the month passes it for the first time.
 * It runs in a transaction of its own, which saves the budget and publishes what it recorded (EVENT-AFTER-COMMIT). A budget
 * saved first by another writer is decided again from a fresh read.
 */
export class ExpenseBudgetPolicy {
  constructor(
    private expenses: IExpenseRepository,
    private budgets: IBudgetRepository,
    private spending: IBudgetQueries,
    private groupMembers: IGroupMembers,
  ) {}

  async decide(expenseId: string, context: ExecutionContext): Promise<IResult> {
    for (let attempt = 1; ; attempt++) {
      const expense = await this.expenses.findById(expenseId);
      if (!expense) return Result.ok();

      const { groupId, category, date } = expense.toSnapshot();
      const month = date.slice(0, 7);
      const budget = await this.budgets.findFor(groupId, category);
      if (!budget) return Result.ok();

      const spent = await this.spending.spentIn(groupId, category, month);
      const memberIds = await this.groupMembers.currentMemberIds(groupId);
      const passed = budget.decide({ month, spent, memberIds });
      if (!passed) return Result.ok();

      const saved = await this.budgets.save(passed);
      if (saved.isFailure()) {
        if (saved.error instanceof ConcurrencyConflictException && attempt < ATTEMPTS) continue;
        return Result.fail(saved.error);
      }

      await publishDomainEvents(passed, context);
      return Result.ok();
    }
  }
}
