import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

/** The payload of ExpenseRecorded, as conventions/integration-events.yaml declares it (its last version). */
export interface ExpenseRecordedPayload {
  expenseId: string;
  groupId: string;
  paidBy: string;
  shares: { memberId: string; amount: number }[];
}

/** An expense was recorded, under the id it was born with: who paid it, and each member's share of it, as it was split. */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<ExpenseRecordedPayload> {}
