import { IResult, Result } from '@Architecture/Domain';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishIntegrationEvent } from '@Architecture/Application/DomainEvents';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/ExpenseEvents';

/**
 * The policy that tells the other contexts an expense was recorded (ADR 14): it translates Ledger's domain event into the
 * published `ExpenseRecorded`, through the outbox, in a transaction of its own. Nothing about who is told is Ledger's to know.
 */
export class ExpenseRecordedHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute(event: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { expenseId, groupId, paidBy, amount, shares } = event.payload;
    await publishIntegrationEvent(
      ExpenseRecordedIntegrationEvent.set({
        expenseId,
        groupId,
        paidBy,
        amount,
        shares: shares.map(({ memberId, amount: share }) => ({ memberId, amount: share })),
      }),
      context,
    );
    return Result.ok(undefined);
  }
}
