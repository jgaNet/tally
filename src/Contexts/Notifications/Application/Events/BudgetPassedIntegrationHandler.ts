import { Clock, EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * Tells each member of the group that a month passed a category's budget (request 24, docs/adr/0023): one notice each, in this reaction's
 * transaction, with what the month spends. The payer is told too: a budget is the whole group's. The store keeps one notice per person,
 * group, category and month, so a fact that comes again after a restart makes none twice.
 */
export class BudgetPassedIntegrationHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private readonly notices: INotices,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: BudgetPassedIntegrationEvent, context: ExecutionContext) {
    for (const memberId of payload.memberIds) {
      const notice = Notice.issueBudget({
        accountId: memberId,
        groupId: payload.groupId,
        category: payload.category,
        month: payload.month,
        budget: payload.budget,
        amount: payload.spent,
        at: this.clock(),
      });
      if (await this.notices.save(notice)) await publishDomainEvents(notice, context);
    }
    return Result.ok(undefined);
  }
}
