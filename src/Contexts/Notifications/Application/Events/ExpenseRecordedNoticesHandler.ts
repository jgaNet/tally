import { EventHandler, ExecutionContext, publishDomainEvents, Clock } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferenceRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

/**
 * Tells each member of an expense's split but its payer their share (ADR 11). The reaction runs in one transaction: the
 * notices it makes, and the NoticeIssued facts they record, are stored together or not at all, and the bus hands the
 * fact to it once, so each member is told once. The payer is not told: they recorded it, and a member who turned expense
 * notices off is not told (request 36): the preference in force when the expense is recorded decides.
 */
export class ExpenseRecordedNoticesHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeRepository,
    private readonly preferences: INoticePreferenceRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: ExpenseRecordedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { expenseId, groupId, paidBy, shares } = event.payload;
    const at = this.clock();
    for (const share of shares) {
      if (share.memberId === paidBy) continue;
      const preferences = await this.preferences.findByMember(new Id(share.memberId));
      if (!NoticePreferences.wants(preferences, 'expense')) continue;
      const notice = Notice.create({
        memberId: new Id(share.memberId),
        groupId: new Id(groupId),
        expenseId: new Id(expenseId),
        amount: share.amount,
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
