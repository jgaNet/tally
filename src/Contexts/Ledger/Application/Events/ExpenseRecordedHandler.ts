import { IResult, Result } from '@Architecture/Domain';
import { EventHandler, ExecutionContext, publishIntegrationEvent } from '@Architecture/Application';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * Where an expense's recording leaves Ledger (request 17, ADR 6): the domain event, Ledger's own words, is restated as the
 * published ExpenseRecorded, and goes out through the outbox when this reaction's transaction commits. Ledger knows
 * nothing of who reacts to it, nor of who is told.
 */
export class ExpenseRecordedHandler extends EventHandler<ExpenseRecordedEvent> {
  async execute({ payload }: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult> {
    await publishIntegrationEvent(
      ExpenseRecordedIntegrationEvent.set({
        expenseId: payload.expenseId,
        groupId: payload.groupId,
        paidBy: payload.paidBy,
        amount: payload.amount,
        shares: payload.shares.map(({ memberId, amount }) => ({ memberId, amount })),
      }),
      context,
    );
    return Result.ok();
  }
}
