import { CommandEvent } from '@Architecture/Domain';

/** The expense a member removes. */
export class DeleteExpenseCommandEvent extends CommandEvent<{ expenseId: string }> {}
