import { IntegrationEvent } from '@Architecture/Domain';

/** One member of an expense's split, and what they owe of it (ExpenseRecorded, version 1). */
export interface ExpenseRecordedShare {
  readonly memberId: string;
  readonly amount: number;
}

/** The payload of ExpenseRecorded, version 1 (conventions/integration-events.yaml): the expense's id, its group, its payer and its shares. */
export interface ExpenseRecordedIntegrationPayload {
  readonly expenseId: string;
  readonly groupId: string;
  readonly paidBy: string;
  readonly shares: readonly ExpenseRecordedShare[];
}

/**
 * ExpenseRecorded: an expense was recorded in a group, and who owes what of it. Ledger publishes it through the outbox after the
 * recording commits (ADR 12, ADR 13); Notifications turns it into a notice for each member of the split but the payer.
 */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<ExpenseRecordedIntegrationPayload> {}
