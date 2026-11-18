import { CommandEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseMoney } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The payload of an expense: the group it is recorded in (as the route names it), and what the member typed. Its values
 * are checked by the domain, not here; the payer is the caller, not a field. The money is the amount in the group's
 * currency, or what was paid in another currency at its rate (request 21).
 */
export interface RecordExpensePayload {
  groupId: string;
  description: string;
  money: ExpenseMoney;
  date: string;
  /** How the expense is split: equally, by exact amounts, or by shares. */
  split: SplitRequest;
  /** The category, one of eight; `other` when none is given (request 24). */
  category?: Category;
}

export class RecordExpenseCommandEvent extends CommandEvent<RecordExpensePayload> {}
