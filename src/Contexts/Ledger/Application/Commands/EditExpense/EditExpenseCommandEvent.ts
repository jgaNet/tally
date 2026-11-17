import { CommandEvent } from '@Architecture/Domain';

/**
 * A member edits an expense whole, from the version they read (the caller is its payer or the group's owner). The body is
 * the expense as it is given again, under the rules of recording it.
 */
export class EditExpenseCommandEvent extends CommandEvent<{
  expenseId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
  version: number;
}> {}
