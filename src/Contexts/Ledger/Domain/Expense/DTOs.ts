import { ExpenseShare } from '@Contexts/Ledger/Domain/Expense/Split';

/** The plain shape of an expense that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IExpenseSnapshot {
  _id: string;
  groupId: string;
  description: string;
  amount: number;
  /** The day spent, YYYY-MM-DD. */
  date: string;
  paidBy: string;
  /** The shares in the order the split was given. */
  shares: ExpenseShare[];
  version: number;
}
