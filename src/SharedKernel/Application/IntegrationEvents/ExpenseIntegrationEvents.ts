import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

/** A member's part of an expense, in the published words of Ledger. */
export interface ExpenseRecordedShare {
  memberId: string;
  amount: number;
}

export interface ExpenseRecordedPayload {
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  shares: ExpenseRecordedShare[];
}

/**
 * Published by Ledger when an expense is recorded (request 17, ADR 6): the expense's id, its group, the member who paid
 * it, its amount and each member's share, in the order of the split. Everything a consumer needs, so it never asks Ledger
 * back. Only the recording is published: an edit or a deletion stays Ledger's own fact.
 */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<ExpenseRecordedPayload> {}
