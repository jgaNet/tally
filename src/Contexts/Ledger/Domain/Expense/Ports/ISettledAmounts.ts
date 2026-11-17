/** What a member has moved in the settlements of a group, in Ledger's words: their balance goes up by `amount` (docs/adr/0013). */
export interface SettledAmount {
  memberId: string;
  /** What the member paid in settlements less what they received: added to what is owed to them, or to what they owe. */
  amount: number;
}

/**
 * What has been settled in a group, read when a balance is read (conventions/domain.yaml, the SettledAmounts link; docs/adr/0013).
 * Ledger owns the port, in its own words; Settlements answers it through an adapter in Ledger's Infrastructure, over Settlements'
 * read model. A balance never misses a settlement that is paid.
 */
export interface ISettledAmounts {
  settledOf(groupId: string): Promise<SettledAmount[]>;
}
