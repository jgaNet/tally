import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

/**
 * Tells the other contexts a month passed a category's budget, in the public words of the published language (BudgetPassed): the
 * fact carries the group, the category, the month, the budget, what the month spent and the members to tell, so a reaction needs
 * nothing from Ledger's store. It is made durable in this reaction's transaction and published from the outbox after it commits.
 */
export class BudgetPassedHandler extends EventHandler<BudgetPassedEvent> {
  async execute({ payload }: BudgetPassedEvent, context: ExecutionContext): Promise<IResult<void>> {
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({
        groupId: payload.groupId,
        category: payload.category,
        month: payload.month,
        budget: payload.budget,
        spent: payload.spent,
        members: payload.members,
      }),
      context,
    );
    return Result.ok();
  }
}
