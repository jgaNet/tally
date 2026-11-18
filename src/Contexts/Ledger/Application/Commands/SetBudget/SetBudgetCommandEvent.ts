import { CommandEvent } from '@Architecture/Domain';

/**
 * The owner of a group sets its monthly budget for a category, replacing the one it had (request 24). The category and the amount are
 * checked by the budget, behind the 202.
 */
export class SetBudgetCommandEvent extends CommandEvent<{ groupId: string; category: string; amount: number }> {}
