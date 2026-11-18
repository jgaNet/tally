import { Id } from '@Architecture/Domain';

/**
 * The currency of a group, asked by Ledger in its own words (GroupCurrency, ADR 14): an expense paid in another currency is
 * converted to the group's, so Ledger asks it when it decides such an expense. Its adapter answers it over Groups' read side.
 */
export interface IGroupCurrency {
  /** The currency the group was made in (EUR, USD, …); null when the group does not exist. */
  currencyOf(groupId: Id): Promise<string | null>;
}
