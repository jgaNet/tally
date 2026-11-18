import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense as the store keeps it, whole, so that the aggregate can be read back from it (request 23). */
export interface RecurringExpenseSnapshot {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  split: SplitInput;
  /** What the expenses it records are for (request 24): `other` when none was given. */
  category: Category;
  version: number;
}

/**
 * A recurring expense as the queries answer it (request 23): the split as it was given, under the name the API gives it, exactly
 * one of the three.
 */
export interface RecurringExpenseView {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  /** What the expenses it records are for (request 24). */
  category: Category;
  splitBetween?: string[];
  splitExactly?: Array<{ memberId: string; amount: number }>;
  splitByShares?: Array<{ memberId: string; shares: number }>;
}
