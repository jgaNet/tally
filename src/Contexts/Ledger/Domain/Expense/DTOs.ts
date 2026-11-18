import { OriginalSnapshot } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { ExpenseShare, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

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
  /** How it was split: equally, by exact amounts, or by shares. */
  splitKind: SplitKind;
  /** What was paid in another currency, at its rate; null when the expense is in the group's currency (request 21). */
  original: OriginalSnapshot | null;
  version: number;
}
