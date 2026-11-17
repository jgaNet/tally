import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';

import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

/**
 * Tells the other contexts an expense was recorded (ExpenseRecorded, the published language, ADR 12 and ADR 13): the domain event of
 * the recording, translated into the integration event, which is made durable in this reaction's transaction and published after it
 * commits. Nothing else is told: an edit and a deletion stay Ledger's own facts.
 */
export class ExpenseRecordedHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute(event: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { expenseId, groupId, paidBy, shares } = event.payload;
    await publishIntegrationEvent(
      ExpenseRecordedIntegrationEvent.set({
        expenseId,
        groupId,
        paidBy,
        shares: shares.map(({ memberId, amount }) => ({ memberId, amount })),
      }),
      context,
    );
    return Result.ok(undefined);
  }
}
