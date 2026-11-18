import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { IAuditLog } from '@Contexts/Ledger/Application/IAuditLog';
import { IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IRecurringExpenseStore } from '@Contexts/Ledger/Application/IRecurringExpenseStore';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';

/**
 * Moves what the group merged held in Ledger to the group kept (request 31, feature 31): its expenses with their receipts (which follow
 * the expense), its recurring expenses and the entries of its audit (ledger_audit). Each expense and recurring expense keeps its id, its
 * version and everything it says but its group; the move records ExpenseMoved and RecurringExpenseMoved, in this reaction's transaction.
 * It runs once the merge has committed (GroupsMerged, the bus delivers it once), and a second delivery finds nothing left to move. The
 * balances of the group kept read the moved expenses from then on, so each member's balance is what it was plus what it was in the group
 * merged, within the reaction's time.
 */
export class MoveMergedGroupHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly expenses: IExpenseStore,
    private readonly recurring: IRecurringExpenseStore,
    private readonly audit: IAuditLog,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { keptGroupId, mergedGroupId } = event.payload;
    const now = this.clock();

    for (const view of await this.expenses.listOf(mergedGroupId)) {
      const expense = await this.expenses.findById(view.id);
      if (!expense) continue;
      expense.moveTo(keptGroupId, now);
      await this.expenses.move(expense);
      await publishDomainEvents(expense, context);
    }
    for (const view of await this.recurring.listOf(mergedGroupId)) {
      const recurring = await this.recurring.findById(view.id);
      if (!recurring) continue;
      recurring.moveTo(keptGroupId, now);
      await this.recurring.move(recurring);
      await publishDomainEvents(recurring, context);
    }
    await this.audit.moveGroup(mergedGroupId, keptGroupId);
    return Result.ok(undefined);
  }
}
