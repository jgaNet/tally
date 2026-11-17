import { IntegrationEvent } from '@Architecture/Domain';

/**
 * An expense was recorded (request 4), published by Ledger (conventions/integration-events.yaml, ADR 14): the expense's id,
 * the group it was recorded in, the member who paid it, its amount and each member's share of it. Notifications makes a notice
 * for each share but the payer's; nothing else reads it.
 */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  shares: { memberId: string; amount: number }[];
}> {}
