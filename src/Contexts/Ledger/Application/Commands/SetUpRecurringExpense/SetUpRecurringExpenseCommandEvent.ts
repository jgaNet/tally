import { CommandEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The payload of a recurring expense set up: the group it is set up in (as the route names it), and what the member typed. The
 * payer is the caller. Its values are checked by the domain, not here.
 */
export interface SetUpRecurringExpensePayload {
  groupId: string;
  description: string;
  amount: number;
  startsOn: string;
  /** How it is split: equally, by exact amounts, or by shares, as the expenses it records are. */
  split: SplitRequest;
  /** The category of the expenses it records, one of eight; `other` when none is given (request 24). */
  category?: Category;
}

export class SetUpRecurringExpenseCommandEvent extends CommandEvent<SetUpRecurringExpensePayload> {}
