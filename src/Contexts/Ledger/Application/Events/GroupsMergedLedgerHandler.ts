import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';

/**
 * Moves what Ledger holds of a group merged into the group kept (request 31, ADR 23): every expense, with its receipt, its
 * shares and its version (ExpenseMoved), every recurring expense (RecurringExpenseMoved), and the entries of its audit. It runs
 * in one transaction, after the write lock every write takes, as recording an expense does: an expense recorded before the merge
 * is moved here, and one asked after it reads a group that no longer exists and is refused. An expense adds up to 0, so the
 * balances of each group add up to 0 whichever of them have moved. The group merged's budgets and templates are dropped with it:
 * nothing reads them once it is gone.
 */
export class GroupsMergedLedgerHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly recurring: IRecurringExpenseRepository,
    private readonly audit: IAuditTrail,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const kept = new Id(event.payload.groupId);
    const merged = new Id(event.payload.mergedGroupId);
    const at = this.clock();

    for (const id of await this.expenses.idsInGroup(merged)) {
      const expense = await this.expenses.findById(id);
      if (!expense) continue;
      const moved = expense.moveTo(kept, at);
      const saved = await this.expenses.save(moved);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(moved, context);
    }
    for (const id of await this.recurring.idsInGroup(merged)) {
      const recurring = await this.recurring.findById(id);
      if (!recurring) continue;
      const moved = recurring.moveTo(kept, at);
      const saved = await this.recurring.save(moved);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(moved, context);
    }
    await this.audit.moveGroup(merged.value, kept.value);
    return Result.ok();
  }
}
