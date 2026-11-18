import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceRepository';

/**
 * Anti-corruption layer of Notifications towards Ledger (request 17, ADR 6, ADR 9). It knows the published contract,
 * ExpenseRecorded, and nothing else of Ledger: it restates the fact in Notifications' words and makes one notice for each
 * member of the split but its payer, at the application's clock, in this reaction's own transaction. The outbox and the
 * bus's inbox hand the fact here once; a notice is made once from the fact, so a member who already holds one is not told
 * again. A member who has turned expense notices off (request 36) is not told, from the moment they turned it off.
 */
export class ExpenseRecordedIntegrationEventHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private notices: INoticeRepository,
    private preferences: INoticePreferenceRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ExpenseRecordedIntegrationEvent, context: ExecutionContext): Promise<IResult> {
    const toTell = Notice.toTellOfExpense({
      paidBy: payload.paidBy,
      shares: payload.shares,
      alreadyTold: await this.notices.recipientsOf(payload.expenseId),
    });
    const at = this.clock();

    for (const { memberId, amount } of toTell) {
      const preferences = (await this.preferences.findByPerson(memberId)) ?? NoticePreferences.open(memberId);
      if (!preferences.wants('expense')) continue;

      const notice = Notice.issue({
        recipient: memberId,
        groupId: payload.groupId,
        expenseId: payload.expenseId,
        amount,
        at,
      });
      if (notice.isFailure()) return Result.fail(notice.error);
      const saved = await this.notices.save(notice.data);
      if (saved.isFailure()) return Result.fail(saved.error);
      await publishDomainEvents(notice.data, context);
    }
    return Result.ok();
  }
}
