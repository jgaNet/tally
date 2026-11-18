import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { IAuditEntries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditEntries';

/**
 * Ledger's reaction to a merge (request 31, ADR 21): the expenses and the recurring expenses of the group merged are the group
 * kept's, each moved in this reaction's own transaction, with the audit entries of the group merged. Each keeps its id, its version
 * and everything it says but its group; a move records ExpenseMoved or RecurringExpenseMoved. The group merged is gone already, so
 * no expense is recorded in it any more, and the ones it held are listed here once, by their read model.
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private expenseQueries: IExpenseQueries,
    private expenses: IExpenseRepository,
    private recurringQueries: IRecurringExpenseQueries,
    private recurring: IRecurringExpenseRepository,
    private audit: IAuditEntries,
  ) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult> {
    const { keptGroupId, mergedGroupId } = payload;

    for (const { id } of await this.expenseQueries.listGroupExpenses(mergedGroupId)) {
      const expense = await this.expenses.findById(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
      expense.moveTo(keptGroupId);
      const moved = await this.expenses.move(expense);
      if (moved.isFailure()) return Result.fail(moved.error);
      await publishDomainEvents(expense, context);
    }

    for (const { id } of await this.recurringQueries.listGroupRecurring(mergedGroupId)) {
      const recurring = await this.recurring.findById(id);
      if (!recurring) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
      recurring.moveTo(keptGroupId);
      const moved = await this.recurring.move(recurring);
      if (moved.isFailure()) return Result.fail(moved.error);
      await publishDomainEvents(recurring, context);
    }

    await this.audit.moveGroup(mergedGroupId, keptGroupId);
    return Result.ok();
  }
}
