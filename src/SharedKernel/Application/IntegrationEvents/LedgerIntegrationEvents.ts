import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

/** An expense was recorded, with its shares as they were recorded (conventions/integration-events.yaml, ADR 11). */
export interface ExpenseRecordedPayload {
  expenseId: string;
  groupId: string;
  paidBy: string;
  shares: { memberId: string; amount: number }[];
}

/** Published by Ledger after an expense is recorded, through the outbox; Notifications tells each member of the split but the payer. */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<ExpenseRecordedPayload> {}
