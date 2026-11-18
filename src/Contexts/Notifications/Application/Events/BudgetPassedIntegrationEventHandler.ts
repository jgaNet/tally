import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';

/**
 * The anti-corruption reaction to Ledger's `BudgetPassed` (request 24, ADR 21): one notice for each member the fact names, the payer
 * of the expense that passed the budget among them, stored and published in the reaction's own transaction. The fact is made once for a
 * group, a category and a month, and the bus hands it over once, so the reaction is not made idempotent by hand; a failure rolls its
 * notices back and the fact is handed over again.
 */
export class BudgetPassedIntegrationEventHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeStore,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    const issued = Notice.budgetPassed({ groupId, category, month, budget, spent, memberIds, at: this.clock() });
    await this.notices.insert(issued);
    for (const notice of issued) await publishDomainEvents(notice, context);
    return Result.ok(undefined);
  }
}
