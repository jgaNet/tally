import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/**
 * Makes one notice for each member Ledger says to tell when a month passed a category's budget (request 24), the payer of the
 * expense that passed it among them. The notices are saved in this reaction's transaction, and the bus hands the fact over once, so a
 * member is noticed once however the server stops and starts (nothing here is idempotent by hand).
 */
export class BudgetPassedIntegrationEventHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private notices: INoticeRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    for (const member of payload.members) {
      const made = Notice.overBudget({
        recipient: new Id(member),
        groupId: new Id(payload.groupId),
        category: payload.category,
        month: payload.month,
        budget: payload.budget,
        spent: payload.spent,
        now: this.clock(),
      });
      if (made.isFailure()) return made;

      const saved = await this.notices.save(made.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(made.data, context);
    }
    return Result.ok();
  }
}
