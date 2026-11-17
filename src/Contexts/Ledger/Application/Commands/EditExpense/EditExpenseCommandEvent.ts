import { CommandEvent } from '@Architecture/Domain';

/**
 * The expense a member gives again, whole: what it is for, what it cost, its date, the members it is split between, and
 * the version the member read it at. Its payer is not given: it stays the one who paid.
 */
export class EditExpenseCommandEvent extends CommandEvent<{
  expenseId: string;
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
  version: number;
}> {}
