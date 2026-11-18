import { CommandEvent } from '@Architecture/Domain';

/** A member stops a recurring expense: it no longer exists, and no expense is recorded for it from then on (the caller is its payer or the owner). */
export class StopRecurringExpenseCommandEvent extends CommandEvent<{ recurringExpenseId: string }> {}
