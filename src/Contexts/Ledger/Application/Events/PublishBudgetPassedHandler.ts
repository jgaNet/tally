import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';

import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Budget';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

/**
 * Tells the other contexts a month passed its category's budget (BudgetPassed, the published language, ADR 19): the domain event of the
 * judgement, translated into the integration event, made durable in this reaction's transaction and published after it commits. Nothing
 * else is told: a budget set or removed stays Ledger's own fact.
 */
export class PublishBudgetPassedHandler extends EventHandler<BudgetPassedEvent> {
  async execute(event: BudgetPassedEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({ groupId, category, month, budget, spent, memberIds: [...memberIds] }),
      context,
    );
    return Result.ok(undefined);
  }
}
