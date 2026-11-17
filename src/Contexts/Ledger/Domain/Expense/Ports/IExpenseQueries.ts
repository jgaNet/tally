import { BalanceView, ExpenseView } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** The read side of the expenses: what the queries answer, read at once (docs/adr/0004). */
export interface IExpenseQueries {
  /** The expense, with its shares in the order of the split, or undefined when there is no such expense. */
  findExpense(expenseId: string): Promise<ExpenseView | undefined>;
  /**
   * What each member of the group paid, less what their shares of its expenses are, one read of the group's expenses
   * (docs/adr/0005). Only a member who paid or has a share is listed; the rest of the group is 0. Over all of them the
   * balances add up to 0, since every expense's shares add up to its amount.
   */
  balancesOf(groupId: string): Promise<BalanceView[]>;
}
