import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';

/**
 * Tells the other contexts an expense was recorded, in the public words of the published language (ExpenseRecorded): the
 * fact is carried as it was recorded, its payer and each member's share, so a reaction needs nothing from Ledger's store. The
 * integration event is made durable in this reaction's transaction and published from the outbox after it commits (ADR 9).
 */
export class ExpenseRecordedHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute({ payload }: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult<void>> {
    await publishIntegrationEvent(
      ExpenseRecordedIntegrationEvent.set({
        expenseId: payload.expenseId,
        groupId: payload.groupId,
        paidBy: payload.paidBy,
        shares: payload.shares,
      }),
      context,
    );
    return Result.ok();
  }
}
