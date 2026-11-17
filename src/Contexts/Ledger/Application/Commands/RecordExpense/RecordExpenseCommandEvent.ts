import { CommandEvent } from '@Architecture/Domain';

/** A member records an expense they paid, split between the members given (the payer is the caller). */
export class RecordExpenseCommandEvent extends CommandEvent<{
  groupId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}> {}
