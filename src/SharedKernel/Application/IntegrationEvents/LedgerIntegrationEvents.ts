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

/** A month's spending in a category passed its budget, with the members to tell (request 24, ADR 17). */
export interface BudgetPassedPayload {
  groupId: string;
  category: string;
  month: string;
  budget: number;
  spent: number;
  memberIds: string[];
}

/** Published by Ledger once a month's spending in a category passes its budget, through the outbox; Notifications tells each member. */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<BudgetPassedPayload> {}
