import { IntegrationEvent } from '@Architecture/Domain';

/**
 * An expense was recorded in a group (request 17, docs/adr/0017): Ledger's fact, in its public words. It carries what a
 * consumer needs and never asks back: the expense, its group, who paid it, and each member's share (`{ memberId, amount }`, in
 * the order of the split). Edits and deletions are not told.
 */
export class ExpenseRecordedIntegrationEvent extends IntegrationEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  shares: { memberId: string; amount: number }[];
}> {}
