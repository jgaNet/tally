import { CommandEvent } from '@Architecture/Domain';

import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The payload of an edit: the expense (as the route names it), and the expense whole as its author means it, with the
 * version they read. Its values are checked by the domain, not here; the editor is the caller, not a field.
 */
export interface EditExpensePayload {
  expenseId: string;
  description: string;
  amount: number;
  date: string;
  /** How the expense is split, as the edit gives it: equally, by exact amounts, or by shares. */
  split: SplitRequest;
  version: number;
}

export class EditExpenseCommandEvent extends CommandEvent<EditExpensePayload> {}
