import { ExpenseShare, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a member reads of an expense: as it is now, its version, and its shares in the order of the split. */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ExpenseShare[];
  /** How it was split: equally, by exact amounts, or by shares. */
  splitKind: SplitKind;
  /** 1 when it is recorded, and one more at each edit. */
  version: number;
}

/** The read side of expenses: a read model, never an aggregate (QUERY-READ-MODELS). Membership is not asked here. */
export interface IExpenseQueries {
  /** The expense with this id, or null when there is none. */
  findExpense(id: string): Promise<ExpenseView | null>;
}
