import { CommandEvent } from '@Architecture/Domain';

/** The expense a member paid: its group, what it was for, its amount, its date, and the members it is split between. */
export class RecordExpenseCommandEvent extends CommandEvent<{
  groupId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}> {}
