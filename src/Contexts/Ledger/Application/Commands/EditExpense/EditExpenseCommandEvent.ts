import { CommandEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseMoney } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The payload of an edit: the expense (as the route names it), and the expense whole as its author means it, with the
 * version they read. Its values are checked by the domain, not here; the editor is the caller, not a field.
 */
export interface EditExpensePayload {
  expenseId: string;
  description: string;
  /** The amount in the group's currency, or what was paid in another currency at its rate (request 21). */
  money: ExpenseMoney;
  date: string;
  /** How the expense is split, as the edit gives it: equally, by exact amounts, or by shares; or left out, when `template` names it (request 25). */
  split?: SplitRequest;
  /** The id of a template of the group, whose split the edit gives instead of `split` (request 25). */
  template?: string;
  version: number;
  /** The category as the edit gives it, one of eight; `other` when none is given (request 24). */
  category?: Category;
}

export class EditExpenseCommandEvent extends CommandEvent<EditExpensePayload> {}
