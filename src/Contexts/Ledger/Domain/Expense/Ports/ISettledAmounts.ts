/** One member's change in balance, as the settlements that were paid count it: positive when the member paid, negative when paid to. */
export interface SettledAmount {
  memberId: string;
  amount: number;
}

/**
 * A settlement the balances count, as a member's statement lists it (request 29): who paid whom, how much, how it was paid,
 * and when the balances started to count it (an ISO instant, as the clock gave it).
 */
export interface CountedSettlement {
  settlementId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  countedAt: string;
}

/**
 * Ledger's own port onto Settlements: what the settlements of a group that were paid move each member's balance by, as
 * Ledger counts a balance (ADR 8). Ledger asks it when it reads a balance, so a balance never misses a settlement that is
 * paid, and nothing is copied. The adapter answers over Settlements' read model; no domain imports Settlements.
 */
export interface ISettledAmounts {
  /** The changes of the settlements paid in the group, one per member and settlement, which add up to 0 for each settlement. */
  settledOf(groupId: string): Promise<SettledAmount[]>;
  /**
   * The settlements of the group the balances count that the member paid or received, in the order they were recorded, each
   * with when the balances started to count it (request 29). Ledger's statement asks it, and nothing else does.
   */
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}
