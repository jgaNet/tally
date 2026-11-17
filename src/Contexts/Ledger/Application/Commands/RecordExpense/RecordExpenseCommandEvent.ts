import { CommandEvent } from '@Architecture/Domain';

import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The payload of an expense: the group it is recorded in (as the route names it), and what the member typed. Its values
 * are checked by the domain, not here; the payer is the caller, not a field.
 */
export interface RecordExpensePayload {
  groupId: string;
  description: string;
  amount: number;
  date: string;
  /** How the expense is split: equally, by exact amounts, or by shares. */
  split: SplitRequest;
}

export class RecordExpenseCommandEvent extends CommandEvent<RecordExpensePayload> {}
