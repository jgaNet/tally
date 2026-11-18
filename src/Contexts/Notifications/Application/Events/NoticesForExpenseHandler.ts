import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { INoticePreferenceStore } from '@Contexts/Notifications/Application/INoticePreferenceStore';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * Makes a notice for each member of an expense's split but its payer, with their share (request 17, ADR 13): the reaction to
 * ExpenseRecorded. The payer receives none: they recorded it, and a member who has turned expenses off receives none (request 36). It runs in its own transaction, so the notices it makes and their facts
 * commit together or not at all, and the bus hands it the expense once (ADR 12), so each member gets one notice even across restarts.
 */
export class NoticesForExpenseHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeStore,
    private readonly preferences: INoticePreferenceStore,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: ExpenseRecordedIntegrationEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { expenseId, groupId, paidBy, shares } = event.payload;
    const now = this.clock();
    for (const share of shares) {
      if (share.memberId === paidBy) continue;
      if (!(await this.preferences.preferencesOf(share.memberId)).isOn('expense')) continue;
      const notice = Notice.create({ recipientId: share.memberId, groupId, expenseId, amount: share.amount }, now);
      await this.notices.add(notice);
      await publishDomainEvents(notice, context);
    }
    return Result.ok(undefined);
  }
}
