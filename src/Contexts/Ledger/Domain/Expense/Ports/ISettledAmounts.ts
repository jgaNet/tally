/** One member's change in balance, as the settlements that were paid count it: positive when the member paid, negative when paid to. */
export interface SettledAmount {
  memberId: string;
  amount: number;
}

/**
 * Ledger's own port onto Settlements: what the settlements of a group that were paid move each member's balance by, as
 * Ledger counts a balance (ADR 8). Ledger asks it when it reads a balance, so a balance never misses a settlement that is
 * paid, and nothing is copied. The adapter answers over Settlements' read model; no domain imports Settlements.
 */
export interface ISettledAmounts {
  /** The changes of the settlements paid in the group, one per member and settlement, which add up to 0 for each settlement. */
  settledOf(groupId: string): Promise<SettledAmount[]>;
}
