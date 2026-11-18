import { CommandEvent } from '@Architecture/Domain';

/** The owner of a group removes its budget for a category (request 24). */
export class RemoveBudgetCommandEvent extends CommandEvent<{ groupId: string; category: string }> {}
