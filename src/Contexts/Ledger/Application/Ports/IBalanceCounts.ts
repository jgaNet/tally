import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/**
 * The balances' write side (the read model of Ledger's own facts, T4): an expense is counted into the balances in the
 * transaction that stores it, so a sum is never read half-written and an expense counts once. It runs inside the command's
 * transaction: it must not take the database lock itself.
 */
export interface IBalanceCounts {
  count(expense: Expense): Promise<void>;
  /** Takes an expense out of the balances again: the expense was edited, or deleted, and its counted shares are forgotten. */
  uncount(expense: Expense): Promise<void>;
  /** The balances counted in one group are counted in another, which keeps them: a merge of groups (request 31). */
  moveGroup(fromGroupId: string, toGroupId: string): Promise<void>;
}
