import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Application/INoticePreferenceRepository';

/**
 * The anti-corruption reaction to Ledger's `BudgetPassed` (request 24, ADR 21): one notice for each member the fact names, the payer
 * of the expense that passed the budget among them, stored and published in the reaction's own transaction. The fact is made once for a
 * group, a category and a month, and the bus hands it over once, so the reaction is not made idempotent by hand; a failure rolls its
 * notices back and the fact is handed over again. A member who has budget notices turned off (request 36) is told nothing, and the
 * others are told as before.
 */
export class BudgetPassedIntegrationEventHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeStore,
    private readonly preferences: INoticePreferenceRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    const off = await this.preferences.turnedOff('budget', memberIds);
    const issued = Notice.budgetPassed({
      groupId,
      category,
      month,
      budget,
      spent,
      memberIds: memberIds.filter(memberId => !off.has(memberId)),
      at: this.clock(),
    });
    await this.notices.insert(issued);
    for (const notice of issued) await publishDomainEvents(notice, context);
    return Result.ok(undefined);
  }
}
