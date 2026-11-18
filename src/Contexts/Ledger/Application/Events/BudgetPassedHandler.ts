import { IResult, Result } from '@Architecture/Domain';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishIntegrationEvent } from '@Architecture/Application/DomainEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/BudgetEvents';

/**
 * The policy that tells the other contexts a budget was passed (request 24, ADR 21): it translates Ledger's domain event into the
 * published `BudgetPassed`, through the outbox, in a transaction of its own. The members to tell are the ones the fact carries; what
 * a notice looks like is not Ledger's to know.
 */
export class BudgetPassedHandler extends EventHandler<BudgetPassedEvent> {
  async execute(event: BudgetPassedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    await publishIntegrationEvent(
      BudgetPassedIntegrationEvent.set({ groupId, category, month, budget, spent, memberIds: [...memberIds] }),
      context,
    );
    return Result.ok(undefined);
  }
}
