import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { BudgetPassedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceRepository';

/**
 * Anti-corruption layer of Notifications towards Ledger for a passed budget (request 24, ADR 15). It knows the published contract,
 * BudgetPassed, and nothing else of Ledger: it makes one notice for each member Ledger named to tell, at the application's clock,
 * each in its own transaction, what the notice says in Notifications' words. The bus delivers the fact once, so the notices are
 * made from the fact and not checked again by hand. A member who has turned budget notices off (request 36) is not told; the
 * month is still passed, and nothing is made for them later.
 */
export class BudgetPassedIntegrationEventHandler extends EventHandler<BudgetPassedIntegrationEvent> {
  constructor(
    private notices: INoticeRepository,
    private preferences: INoticePreferenceRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: BudgetPassedIntegrationEvent, context: ExecutionContext): Promise<IResult> {
    const at = this.clock();

    for (const recipient of payload.memberIds) {
      const preferences = (await this.preferences.findByPerson(recipient)) ?? NoticePreferences.open(recipient);
      if (!preferences.wants('budget')) continue;

      const notice = Notice.budgetPassed({
        recipient,
        groupId: payload.groupId,
        category: payload.category,
        month: payload.month,
        budget: payload.budget,
        spent: payload.spent,
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
