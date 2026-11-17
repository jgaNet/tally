import { CommandEvent } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A member records an expense they paid, split as `split` says (the payer is the caller): equally between the members given,
 * by exact amounts, or by shares. The transport gives exactly one of the three kinds (API-BODY-SHAPE).
 */
export class RecordExpenseCommandEvent extends CommandEvent<{
  groupId: string;
  description: string;
  amount: number;
  date: string;
  split: SplitInput;
}> {}
