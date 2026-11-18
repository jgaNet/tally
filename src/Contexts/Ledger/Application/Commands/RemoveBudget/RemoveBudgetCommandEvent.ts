import { CommandEvent } from '@Architecture/Domain';

/** The owner of a group removes the monthly budget of one of its categories (request 24). */
export class RemoveBudgetCommandEvent extends CommandEvent<{
  groupId: string;
  category: string;
}> {}
