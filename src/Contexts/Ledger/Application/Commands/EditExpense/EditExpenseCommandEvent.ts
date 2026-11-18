import { CommandEvent } from '@Architecture/Domain';

import { MoneyInput } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A member edits an expense whole, from the version they read (the caller is its payer or the group's owner). The body is
 * the expense as it is given again, split as `split` says, under the rules of recording it.
 */
export class EditExpenseCommandEvent extends CommandEvent<{
  expenseId: string;
  description: string;
  money: MoneyInput;
  date: string;
  split: SplitInput;
  version: number;
}> {}
