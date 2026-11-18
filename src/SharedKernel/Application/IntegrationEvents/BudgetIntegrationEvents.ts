import { IntegrationEvent } from '@Architecture/Domain';

/**
 * A month's spending in a category went over the category's budget, the first time for that month (request 24), published by Ledger
 * (conventions/integration-events.yaml, ADR 21): the group, the category (one of groceries, rent, utilities, transport, food, travel,
 * leisure, other), the month (`YYYY-MM`, UTC), the budget, what the month spends, and the members to tell, as the group had them when it
 * was decided. Notifications makes a notice for each of them; nothing else reads it.
 */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<{
  groupId: string;
  category: string;
  month: string;
  budget: number;
  spent: number;
  memberIds: string[];
}> {}
