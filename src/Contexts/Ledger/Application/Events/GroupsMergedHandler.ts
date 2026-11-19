import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

import { IAuditEntries } from '@Contexts/Ledger/Application/IAuditEntries';
import { IExpenseRepository } from '@Contexts/Ledger/Application/IExpenseRepository';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Application/IRecurringExpenseRepository';

/**
 * The reaction to Groups' `GroupsMerged` (request 31, ADR 28): the expenses and the recurring expenses of the group merged become the group
 * kept's, each keeping its id, its version and everything it says but its group, and the audit entries of the group merged follow them.
 * Made in one transaction of the reaction's own, with the moved expenses' and recurring expenses' events published after their move.
 * The budgets and the split templates of the group merged are not moved: they are dropped with the group (ADR 28).
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly recurringExpenses: IRecurringExpenseRepository,
    private readonly audit: IAuditEntries,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, mergedGroupId } = event.payload;
    const at = this.clock();
    await this.expenses.inTransaction(async () => {
      for (const expense of await this.expenses.ofGroup(mergedGroupId)) {
        expense.moveTo(groupId, at);
        await this.expenses.saveMoved(expense, mergedGroupId);
        await publishDomainEvents(expense, context);
      }
      for (const recurring of await this.recurringExpenses.ofGroup(mergedGroupId)) {
        recurring.moveTo(groupId, at);
        await this.recurringExpenses.saveMoved(recurring);
        await publishDomainEvents(recurring, context);
      }
      await this.audit.moveGroup(mergedGroupId, groupId);
    });
    return Result.ok(undefined);
  }
}
