/**
 * A settlement the group counts, as Ledger's statement reads it (request 29): who paid whom how much, how it was paid, and when the
 * balances started to count it. Ledger's own words for what Settlements says of it.
 */
export interface CountedSettlement {
  settlementId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  /** When the balances started to count it: the instant it became paid, as ISO 8601 in UTC. */
  countedAt: string;
}

/**
 * What was settled in a group, as Ledger needs it to read a balance (ADR 11): a port Ledger owns, in its own words, answered by an
 * adapter over Settlements' read model (`SettledAmountsOfSettlements`, in the wiring of this context). Settlements' Domain is never
 * imported by the Application.
 */
export interface ISettledAmounts {
  /**
   * The net effect of the group's settlements on each member's balance: a payer's amount goes up by what they paid, a payee's goes
   * down by it, so the map adds up to 0. A member not in the map has 0. One state of the group's settlements, read in one statement.
   */
  settledOf(groupId: string): Promise<ReadonlyMap<string, number>>;
  /**
   * The settlements the group counts in which the member is the payer or the payee, in no order, each with when the balances started
   * to count it (request 29, ADR 26). One state of the group's settlements, read in one statement.
   */
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}
