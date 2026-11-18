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
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}
