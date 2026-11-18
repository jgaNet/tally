import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * A recurring expense as a member of its group reads it (request 23): its payer, description, amount and the day it starts on,
 * the next day it records, and the split as it was given: exactly one of `splitBetween`, `splitExactly` or `splitByShares`.
 */
export interface RecurringExpenseReadModel {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  /** What its expenses are for (request 24). */
  category: CategoryName;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}
