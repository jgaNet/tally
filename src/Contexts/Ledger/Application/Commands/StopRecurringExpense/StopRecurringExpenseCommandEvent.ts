import { CommandEvent } from '@Architecture/Domain';

/** A recurring expense stopped by its payer or the owner of its group. */
export class StopRecurringExpenseCommandEvent extends CommandEvent<{ recurringId: string }> {}
