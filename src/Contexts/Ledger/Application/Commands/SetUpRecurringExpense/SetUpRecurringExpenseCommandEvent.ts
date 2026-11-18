import { CommandEvent } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A member sets up an expense they pay every month (request 23): the caller is its payer, and `startsOn` is the day of its first
 * month. The split is one of the three, as an expense's is (request 7). Each is checked by the recurring expense, behind the 202.
 */
export class SetUpRecurringExpenseCommandEvent extends CommandEvent<{
  groupId: string;
  description: string;
  amount: number;
  startsOn: string;
  split: SplitInput;
  /** One of the eight categories, `other` when none is given (request 24); checked by the expense, behind the 202. */
  category?: string;
}> {}
