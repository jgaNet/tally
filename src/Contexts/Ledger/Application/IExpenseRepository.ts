import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** The expenses, as aggregates, written whole. An expense is never changed once recorded (feature 4). */
export interface IExpenseRepository {
  /** Inserts a new expense with its shares, in one transaction. */
  insert(expense: Expense): Promise<void>;
}
