import { IntegrationEvent } from '@Architecture/Domain/EventTypes';

export interface BudgetPassedPayload {
  groupId: string;
  category: string;
  /** The month the spending passed the budget in, YYYY-MM. */
  month: string;
  /** The budget of the category, in the group's currency. */
  budget: number;
  /** What the month spends in the category, in the group's currency. */
  spent: number;
  /** The members to tell, as they were when Ledger decided: the group's current members, the payer among them. */
  memberIds: string[];
}

/**
 * Published by Ledger when a month's spending in a category passes its budget, for the first time that month (request 24,
 * ADR 15): the group, the category, the month, the budget, what the month spends, and the members to tell. Everything a
 * consumer needs, so it never asks Ledger back. Only the passing is published, once a month.
 */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<BudgetPassedPayload> {}
