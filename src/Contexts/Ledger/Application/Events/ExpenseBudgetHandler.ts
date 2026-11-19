import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { decidePassBudget } from '@Contexts/Ledger/Domain/Budget/Budget.decision';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/ExpenseEvents';

import { IBudgetRepository } from '@Contexts/Ledger/Application/IBudgetRepository';
import { IExpenseQueries } from '@Contexts/Ledger/Application/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * The policy on an expense recorded or edited (request 24, ADR 21), in a transaction of its own: what the expense's month then spends in
 * its category, read from Ledger's own read model, is put to the category's budget, which decides whether the month passes it (once for
 * a month). When it does, the budget is saved with the month it was passed in and records `BudgetPassed`, with the members of the group
 * as they are now, the payer's group read through `GroupMembers`; the fact goes out through the outbox with the budget's change. A month
 * that stays within its budget, a category with none, and a month already passed decide nothing.
 */
export class ExpenseBudgetHandler extends EventHandler<ExpenseRecordedEvent | ExpenseEditedEvent> {
  constructor(
    private readonly budgets: IBudgetRepository,
    private readonly expenses: IExpenseQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    event: ExpenseRecordedEvent | ExpenseEditedEvent,
    context: ExecutionContext,
  ): Promise<IResult<unknown>> {
    return this.budgets.inTransaction(async () => {
      const { groupId, paidBy, category, date } = event.payload;
      const month = date.slice(0, 7);
      const budget = await this.budgets.get(groupId, category);
      if (!budget) return Result.ok(undefined);
      // An expense recorded before the budget was set is not what the budget was set against: setting a budget makes no notice (request 24).
      if ('recordedAt' in event.payload && budget.setAt !== undefined && event.payload.recordedAt < budget.setAt) {
        return Result.ok(undefined);
      }
      const members = await this.groupMembers.membersOf(groupId, paidBy);
      if (!members) return Result.ok(undefined);
      // A deleted member is told nothing any more (request 35): the members the fact carries are the ones still telling people about.
      const told: string[] = [];
      for (const member of members) {
        if (!(await this.groupMembers.deletedOf(member.memberId))) told.push(member.memberId);
      }

      const spent = (await this.expenses.spentByCategory(groupId, month)).get(category) ?? 0;
      const decision = decidePassBudget(
        { budget: budget.toSnapshot(), spent, memberIds: told },
        { month },
        this.clock(),
      );
      if (decision.isFailure()) return decision;
      const outcome = decision.data.state;
      if (outcome.kind === 'nothing') return Result.ok(undefined);

      budget.pass({ month: outcome.month, spent: outcome.spent, memberIds: outcome.memberIds });
      await this.budgets.save(budget);
      await publishDomainEvents(budget, context);
      return Result.ok(undefined);
    });
  }
}
