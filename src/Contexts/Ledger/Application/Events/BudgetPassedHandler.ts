import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';

/**
 * Where a budget's passing leaves Ledger (request 24, ADR 15): the domain event, Ledger's own words, is restated as the
 * published BudgetPassed, and goes out through the outbox when this reaction's transaction commits. Ledger knows nothing of
 * who is told beyond the members it decided on, nor of how they are told.
 */
export class BudgetPassedHandler extends EventHandler<BudgetPassedEvent> {
  async execute({ payload }: BudgetPassedEvent, context: ExecutionContext): Promise<IResult> {
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({
        groupId: payload.groupId,
        category: payload.category,
        month: payload.month,
        budget: payload.budget,
        spent: payload.spent,
        memberIds: [...payload.memberIds],
      }),
      context,
    );
    return Result.ok();
  }
}
