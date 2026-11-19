import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Application/INoticePreferenceRepository';

/**
 * The anti-corruption reaction to Ledger's `ExpenseRecorded` (request 17, ADR 14): one notice for each member of the split but its
 * payer, with that member's share, stored and published in the reaction's own transaction. A member who has expense notices turned off
 * (request 36) gets none, from now on; the others get theirs as before. The bus hands the fact over once, so the reaction is not made
 * idempotent by hand; a failure rolls its notices back and the fact is handed over again.
 */
export class ExpenseRecordedIntegrationEventHandler extends EventHandler<ExpenseRecordedIntegrationEvent> {
  constructor(
    private readonly notices: INoticeStore,
    private readonly preferences: INoticePreferenceRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: ExpenseRecordedIntegrationEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { expenseId, groupId, paidBy, shares } = event.payload;
    const off = await this.preferences.turnedOff(
      'expense',
      shares.map(share => share.memberId),
    );
    const issued = Notice.issueFor({
      groupId,
      expenseId,
      payer: paidBy,
      shares: shares.filter(share => !off.has(share.memberId)),
      at: this.clock(),
    });
    await this.notices.insert(issued);
    for (const notice of issued) await publishDomainEvents(notice, context);
    return Result.ok(undefined);
  }
}
