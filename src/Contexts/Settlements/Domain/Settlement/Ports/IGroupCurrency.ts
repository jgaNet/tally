/**
 * The currency of a group, asked by Settlements in its own words (GroupCurrency, ADR 8): the currency a payment through the
 * provider is asked in. Its adapter answers it over Groups' read side.
 */
export interface IGroupCurrency {
  /** The currency of the group as it was made; null when the group does not exist. */
  currencyOf(groupId: string): Promise<string | null>;
}
