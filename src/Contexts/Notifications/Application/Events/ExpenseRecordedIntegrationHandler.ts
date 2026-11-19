import { Clock, EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticePreferences } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferences';

/**
 * Tells each member of a recorded expense's split but its payer (request 17, docs/adr/0017): one notice each, with their share,
 * made in this reaction's transaction. The payer recorded it and is told nothing. A member who turned expense notices off is told nothing
 * of this expense, and the others are told as before (request 36, docs/adr/0036): the preference is read when the notice would be made.
 * The fact reaches here once (the outbox and the bus's inbox); the store's key keeps one notice per person and expense even across a restart.
 */
export class ExpenseRecordedIntegrationHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private readonly notices: INotices,
    private readonly preferences: INoticePreferences,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ExpenseRecordedIntegrationEvent, context: ExecutionContext) {
    for (const share of payload.shares) {
      if (share.memberId === payload.paidBy) continue;
      if (!(await this.preferences.get(share.memberId)).isOn('expense')) continue;
      const notice = Notice.issue({
        accountId: share.memberId,
        groupId: payload.groupId,
        expenseId: payload.expenseId,
        amount: share.amount,
        at: this.clock(),
      });
      if (notice.isFailure()) return notice;
      if (await this.notices.save(notice.data)) await publishDomainEvents(notice.data, context);
    }
    return Result.ok(undefined);
  }
}
