import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * Tells the other contexts that an expense was recorded (ADR 11): the domain event becomes the published one, with the
 * id, the group, the payer and the shares it was recorded with. The reaction runs in its own transaction, and the fact
 * reaches the outbox with the reaction's writes, to be relayed after the commit.
 */
export class ExpenseRecordedEventHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute(event: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { expenseId, groupId, paidBy, shares } = event.payload;
    await publishIntegrationEvent(ExpenseRecordedIntegrationEvent.set({ expenseId, groupId, paidBy, shares }), context);
    return Result.ok();
  }
}
