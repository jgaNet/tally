import { EventHandler, publishIntegrationEvent } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';

/**
 * Tells the other contexts that a month passed a category's budget (request 24, docs/adr/0023): the domain event, made durable with the
 * budget, becomes the published fact `BudgetPassed`, which leaves through the outbox after this reaction commits. Ledger knows nothing of
 * who is told.
 */
export class BudgetPassedHandler extends EventHandler<BudgetPassedEvent> {
  async execute({ payload }: BudgetPassedEvent, context: ExecutionContext) {
    const { groupId, category, month, budget, spent, memberIds } = payload;
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({ groupId, category, month, budget, spent, memberIds }),
      context,
    );
    return Result.ok(undefined);
  }
}
