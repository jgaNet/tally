import { CommandEvent } from '@Architecture/Domain';

/** A member deletes an expense: it no longer exists, and counts in no balance (the caller is its payer or the group's owner). */
export class DeleteExpenseCommandEvent extends CommandEvent<{ expenseId: string }> {}
