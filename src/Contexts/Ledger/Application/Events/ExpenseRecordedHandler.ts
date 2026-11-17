import { EventHandler, publishIntegrationEvent } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * Tells the other contexts that an expense was recorded (request 17, docs/adr/0017): the domain event, made durable with the
 * expense, becomes the published fact `ExpenseRecorded`, which leaves through the outbox after this reaction commits. Ledger knows
 * nothing of who is told.
 */
export class ExpenseRecordedHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute({ payload }: ExpenseRecordedEvent, context: ExecutionContext) {
    const { expenseId, groupId, paidBy, shares } = payload;
    await publishIntegrationEvent(ExpenseRecordedIntegrationEvent.set({ expenseId, groupId, paidBy, shares }), context);
    return Result.ok(undefined);
  }
}
