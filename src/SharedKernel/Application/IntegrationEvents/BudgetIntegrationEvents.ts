import { IntegrationEvent } from '@Architecture/Domain';

/**
 * A month passed a category's budget in a group (request 24, docs/adr/0023): Ledger's fact, in its public words. It is told once for
 * a group, a category and a month, whatever the expenses that follow: `budget` is the budget it passed, `spent` what the month spends
 * in the category when it was passed, and `memberIds` the members to tell, in the order they joined. Notifications makes one notice
 * for each of them.
 */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<{
  groupId: string;
  category: string;
  month: string;
  budget: number;
  spent: number;
  memberIds: string[];
}> {}
