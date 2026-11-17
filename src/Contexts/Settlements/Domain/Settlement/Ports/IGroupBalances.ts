/** One member's balance in a group, as Ledger counts it: positive when the member is owed, negative when the member owes. */
export interface GroupBalance {
  memberId: string;
  balance: number;
}

/**
 * Settlements' own port onto Ledger: what each member of a group owes or is owed, as the expenses recorded so far count
 * it. Settlements asks it when it decides, in its own words; the adapter answers over Ledger's balances read model
 * (ADR 7). No domain imports Ledger.
 */
export interface IGroupBalances {
  /** The balances of the members that any expense of the group counts; a member no expense counts is not listed (0). */
  balancesOf(groupId: string): Promise<GroupBalance[]>;
}
