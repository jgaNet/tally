import { CommandEvent } from '@Architecture/Domain';

import { MoneyInput } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A member records an expense they paid, split as `split` says (the payer is the caller): equally between the members given,
 * by exact amounts, or by shares. The transport gives exactly one of the three kinds (API-BODY-SHAPE). Its money is an amount
 * in the group's currency, or what was paid in another currency at its rate (request 21): exactly one, as the transport gives it.
 */
export class RecordExpenseCommandEvent extends CommandEvent<{
  groupId: string;
  description: string;
  money: MoneyInput;
  date: string;
  split: SplitInput;
}> {}
