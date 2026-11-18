import { IntegrationEvent } from '@Architecture/Domain';

/** The payload of BudgetPassed, version 1 (conventions/integration-events.yaml): a month passed its category's budget in a group. */
export interface BudgetPassedIntegrationPayload {
  readonly groupId: string;
  readonly category: string;
  /** The month passed, `YYYY-MM`. */
  readonly month: string;
  /** The budget the month passed, and what the month spends in the category, in the group's currency's hundredths. */
  readonly budget: number;
  readonly spent: number;
  /** The members to tell: every member of the group when the month passed, the payer among them. */
  readonly memberIds: readonly string[];
}

/**
 * BudgetPassed: a month's spending in a category of a group passed its budget (request 24, ADR 19). Ledger publishes it through the
 * outbox after the judgement commits; Notifications turns it into one notice per member, once for that month.
 */
export class BudgetPassedIntegrationEvent extends IntegrationEvent<BudgetPassedIntegrationPayload> {}
