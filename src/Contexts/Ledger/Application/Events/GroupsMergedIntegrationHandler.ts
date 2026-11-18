import { EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { IMergedGroupRecords } from '@Contexts/Ledger/Application/Ports/IMergedGroupRecords';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IRecurringExpenses } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenses';

/**
 * Moves what Ledger holds of a merged group to the group kept (request 31, docs/adr/0031), in a reaction of its own: each expense and each
 * recurring expense of the group merged is moved, keeping its id, its version and everything but its group; the audit entries and the
 * receipts follow; the budgets and the split templates of the group merged are dropped. The fact reaches here once (the outbox and the
 * bus's inbox), and the moves commit together, so a crash leaves nothing half moved: the next delivery finds what is left.
 */
export class GroupsMergedIntegrationHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly recurring: IRecurringExpenses,
    private readonly records: IMergedGroupRecords,
  ) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext) {
    const { keptGroupId, mergedGroupId } = payload;
    for (const expenseId of await this.expenses.idsOfGroup(mergedGroupId)) {
      const expense = await this.expenses.get(expenseId);
      if (!expense) continue;
      expense.moveTo(keptGroupId);
      const moved = await this.expenses.move(expense);
      if (moved.isFailure()) return moved;
      await publishDomainEvents(expense, context);
    }
    for (const recurringId of await this.recurring.idsOfGroup(mergedGroupId)) {
      const recurring = await this.recurring.get(recurringId);
      if (!recurring) continue;
      recurring.moveTo(keptGroupId);
      const moved = await this.recurring.move(recurring);
      if (moved.isFailure()) return moved;
      await publishDomainEvents(recurring, context);
    }
    await this.records.moveGroup(mergedGroupId, keptGroupId);
    return Result.ok(undefined);
  }
}
