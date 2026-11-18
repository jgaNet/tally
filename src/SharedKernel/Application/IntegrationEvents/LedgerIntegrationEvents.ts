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

/** The payload of BudgetPassed, as conventions/integration-events.yaml declares it (its last version). */
export interface BudgetPassedPayload {
  groupId: string;
  category: string;
  month: string;
  budget: number;
  spent: number;
  members: string[];
}

/** A month spent more than a category's budget, for the first time: the members of the group to tell are carried as they were decided. */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<BudgetPassedPayload> {}
