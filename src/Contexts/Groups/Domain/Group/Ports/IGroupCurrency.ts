/**
 * Groups' read side for another context's command (ADR 8): the currency a group was made in, which is fixed at its
 * creation. Settlements asks it when it asks the provider for a payment, in the currency of the group. Another context
 * reads it through its own port over this one; it is a read model, never an aggregate (QUERY-READ-MODELS).
 */
export interface IGroupCurrency {
  /** The currency of the group, as it was made (EUR, USD, …); null when the group does not exist. */
  currencyOf(groupId: string): Promise<string | null>;
}
