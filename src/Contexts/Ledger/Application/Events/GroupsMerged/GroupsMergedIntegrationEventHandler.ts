import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';

import { IAuditLog } from '@Contexts/Ledger/Application/Ports/IAuditLog';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * Moves what Ledger holds of the group merged into the group kept (request 31), in a reaction of its own and one transaction: each expense
 * and each recurring expense moves (keeping its version, its payer, its shares and its category), the balances counted in the merged group are
 * counted in the kept one, and the audit entries follow. The merged group's budgets and split templates are dropped with it. Receipts follow
 * their expenses, which is what they are keyed by. Nothing here is idempotent by hand: a second delivery finds nothing left in the merged group.
 */
export class GroupsMergedIntegrationEventHandler extends EventHandler<GroupsMergedIntegrationEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private recurringExpenses: IRecurringExpenseRepository,
    private balances: IBalanceCounts,
    private audit: IAuditLog,
    private budgets: IBudgetRepository,
    private templates: ISplitTemplateRepository,
  ) {
    super();
  }

  async execute({ payload }: GroupsMergedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const kept = new Id(payload.keptGroupId);
    const merged = new Id(payload.mergedGroupId);

    for (const expense of await this.expenses.findInGroup(merged)) {
      const moved = expense.moveTo(kept);
      const saved = await this.expenses.move(moved);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(moved, context);
    }
    for (const recurring of await this.recurringExpenses.findInGroup(merged)) {
      const moved = recurring.moveTo(kept);
      const saved = await this.recurringExpenses.move(moved);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(moved, context);
    }

    await this.balances.moveGroup(payload.mergedGroupId, payload.keptGroupId);
    await this.audit.moveGroup(payload.mergedGroupId, payload.keptGroupId);
    await this.budgets.dropGroup(merged);
    await this.templates.dropGroup(merged);
    return Result.ok();
  }
}
