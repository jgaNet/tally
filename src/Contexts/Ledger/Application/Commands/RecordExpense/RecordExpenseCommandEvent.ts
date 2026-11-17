import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of an expense: the group it is recorded in (as the route names it), and what the member typed. Its values
 * are checked by the domain, not here; the payer is the caller, not a field.
 */
export interface RecordExpensePayload {
  groupId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

export class RecordExpenseCommandEvent extends CommandEvent<RecordExpensePayload> {}
