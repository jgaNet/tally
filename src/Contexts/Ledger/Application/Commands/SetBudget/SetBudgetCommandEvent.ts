import { CommandEvent } from '@Architecture/Domain';

/** The owner of a group sets the monthly budget of one of its categories: an amount in the group's currency (request 24). */
export class SetBudgetCommandEvent extends CommandEvent<{
  groupId: string;
  category: string;
  amount: number;
}> {}
