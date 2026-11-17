import { BalanceView, ExpenseView, StatementEntryView } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** The read side of the expenses: what the queries answer, read at once (docs/adr/0004). */
export interface IExpenseQueries {
  /** The expense, with its shares in the order of the split, or undefined when there is no such expense. */
  findExpense(expenseId: string): Promise<ExpenseView | undefined>;
  /**
   * What each member of the group paid, less what their shares of its expenses are, moved by what they settled in the group
   * (docs/adr/0005, docs/adr/0013). Only a member who paid, has a share or settled is listed; the rest of the group is 0.
   * Over all of them the balances add up to 0: every expense's shares add up to its amount, and a settlement moves a payer
   * up as much as its payee goes down.
   */
  balancesOf(groupId: string): Promise<BalanceView[]>;
  /**
   * Every expense of the group, each as `findExpense` answers it, the latest date first and, on the same date, the most
   * recently recorded first (request 8, docs/adr/0008). An edit does not change when an expense was recorded.
   */
  expensesOf(groupId: string): Promise<ExpenseView[]>;
  /**
   * The entries of a member's statement in the group, in one read: every expense the member paid or is in the split of, the
   * earliest date first and, on the same date, the earliest recorded first, each with the balance once it is counted, starting
   * from 0 (request 8, docs/adr/0008).
   */
  statementOf(groupId: string, memberId: string): Promise<StatementEntryView[]>;
}
