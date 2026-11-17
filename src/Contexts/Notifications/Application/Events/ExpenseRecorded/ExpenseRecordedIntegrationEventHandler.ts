import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/**
 * Makes one notice for each member of an expense's split but its payer: the payer recorded it and is told nothing. The notices
 * are saved in this reaction's transaction, and the bus hands the fact over once, so a member is noticed once however the server
 * stops and starts (the outbox and the bus carry it; nothing here is idempotent by hand).
 */
export class ExpenseRecordedIntegrationEventHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private notices: INoticeRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ExpenseRecordedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    for (const share of payload.shares) {
      if (share.memberId === payload.paidBy) continue;

      const made = Notice.create({
        recipient: new Id(share.memberId),
        groupId: new Id(payload.groupId),
        expenseId: new Id(payload.expenseId),
        amount: share.amount,
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
