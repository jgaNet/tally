import { ExpenseView } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** The read side of the expenses: what the queries answer, read at once (docs/adr/0004). */
export interface IExpenseQueries {
  /** The expense, with its shares in the order of the split, or undefined when there is no such expense. */
  findExpense(expenseId: string): Promise<ExpenseView | undefined>;
}
