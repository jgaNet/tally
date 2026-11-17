import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/**
 * The balances' write side (the read model of Ledger's own facts, T4): an expense is counted into the balances in the
 * transaction that stores it, so a sum is never read half-written and an expense counts once. It runs inside the command's
 * transaction: it must not take the database lock itself.
 */
export interface IBalanceCounts {
  count(expense: Expense): Promise<void>;
}
