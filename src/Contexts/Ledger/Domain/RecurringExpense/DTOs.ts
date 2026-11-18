import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense as it is stored: its values, its split as it was given, and its version. */
export interface IRecurringExpenseSnapshot {
  _id: string;
  groupId: string;
  paidBy: string;
  /** The group's currency, which the expenses it records are in. */
  currency: string;
  description: string;
  amount: number;
  startsOn: string;
  /** The day of the next expense it will record. */
  next: string;
  split: SplitRequest;
  /** The category of each expense it records, one of eight (request 24). */
  category: Category;
  version: number;
}
