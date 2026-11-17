import { ExpenseShare } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a member reads of an expense: as recorded, its shares in the order of the split. */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ExpenseShare[];
}

/** The read side of expenses: a read model, never an aggregate (QUERY-READ-MODELS). Membership is not asked here. */
export interface IExpenseQueries {
  /** The expense with this id, or null when there is none. */
  findExpense(id: string): Promise<ExpenseView | null>;
}
