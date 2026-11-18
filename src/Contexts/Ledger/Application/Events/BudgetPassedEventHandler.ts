import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';

/**
 * Tells the other contexts that a month passed its budget (request 24): the domain event becomes the published one, with the
 * group, the category, the month, the budget, what the month spends and the members to tell. Notifications makes one notice
 * per member from it, in its own transaction.
 */
export class BudgetPassedEventHandler extends EventHandler<BudgetPassedEvent> {
  async execute({ payload }: BudgetPassedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, category, month, budget, spent, memberIds } = payload;
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({ groupId, category, month, budget, spent, memberIds }),
      context,
    );
    return Result.ok();
  }
}
