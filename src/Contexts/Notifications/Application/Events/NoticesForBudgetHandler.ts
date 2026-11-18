import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * Makes a notice for each member of a group when a month passes its category's budget (request 24, ADR 19): the reaction to BudgetPassed.
 * Each member is told once, since the month passes once: the notices are made in the reaction's own transaction, together or not at all,
 * and the bus hands it the fact once (ADR 12), so no member gets a second notice across restarts.
 */
export class NoticesForBudgetHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeStore,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    const now = this.clock();
    for (const recipientId of memberIds) {
      const notice = Notice.budget({ recipientId, groupId, category, month, budget, spent }, now);
      await this.notices.add(notice);
      await publishDomainEvents(notice, context);
    }
    return Result.ok(undefined);
  }
}
