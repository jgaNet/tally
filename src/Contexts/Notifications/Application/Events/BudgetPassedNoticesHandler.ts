import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * Tells each member of the group that a month passed the budget of a category (request 24, ADR 17): one budget notice per
 * member, the payer included. The reaction runs in one transaction, and the bus hands the fact over once; the month is told
 * once because Ledger records it passed once, so the reaction is not made idempotent by hand.
 */
export class BudgetPassedNoticesHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { groupId, category, month, budget, spent, memberIds } = event.payload;
    const at = this.clock();
    for (const memberId of memberIds) {
      const notice = Notice.createBudget({
        memberId: new Id(memberId),
        groupId: new Id(groupId),
        category,
        month,
        budget,
        amount: spent,
        at,
      });
      if (notice.isFailure()) return notice;
      const saved = await this.notices.save(notice.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(notice.data, context);
    }
    return Result.ok();
  }
}
