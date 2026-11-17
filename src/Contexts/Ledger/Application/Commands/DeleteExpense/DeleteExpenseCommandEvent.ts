import { CommandEvent } from '@Architecture/Domain';

/** The payload of a deletion: the expense, as the route names it. The deleter is the caller, not a field. */
export interface DeleteExpensePayload {
  expenseId: string;
}

export class DeleteExpenseCommandEvent extends CommandEvent<DeleteExpensePayload> {}
