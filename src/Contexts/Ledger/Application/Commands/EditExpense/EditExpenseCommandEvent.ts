import { CommandEvent } from '@Architecture/Domain';

import { MoneyInput } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitSource } from '@Contexts/Ledger/Application/Commands/SplitSource';

/**
 * A member edits an expense whole, from the version they read (the caller is its payer or the group's owner). The body is
 * the expense as it is given again, split as `split` says (or by a template of its group), under the rules of recording it.
 */
export class EditExpenseCommandEvent extends CommandEvent<{
  expenseId: string;
  description: string;
  money: MoneyInput;
  date: string;
  split: SplitSource;
  /** One of the eight categories, `other` when none is given (request 24); checked by the expense, behind the 202. */
  category?: string;
  version: number;
}> {}
