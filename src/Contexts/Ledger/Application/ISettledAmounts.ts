/**
 * What the settlements of a group do to each member's balance, as Ledger asks it (conventions/domain.yaml, ADR 10, the storm's
 * `SettledAmounts`): a port Ledger owns, in its own words, answered over Settlements' read model. `settledOf` answers the members the
 * settlements have moved, each with the change to its balance in the group's currency's hundredths (a payer's is up by what they
 * paid, a payee's down by what they were paid); a member no settlement has moved is absent. Every balance Ledger reads counts it, and
 * the statement counts it too, line by line (request 29): `countedOf` answers each settlement a member paid or received that the balances
 * count, with when they started to count it. The adapter is Ledger's infrastructure over Settlements' roster, so no domain imports Settlements.
 */
export interface ISettledAmounts {
  settledOf(groupId: string): Promise<SettledChange[]>;
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}

/**
 * A settlement a member paid or received that the balances count (request 29): who paid whom how much, how it was paid, and the instant
 * the balances started to count it (its `countedFrom`, in ISO 8601).
 */
export interface CountedSettlement {
  readonly settlementId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly method: 'cash' | 'provider' | 'net';
  readonly countedFrom: string;
}

/** A member's balance change from the settlements of a group, in hundredths. */
export interface SettledChange {
  readonly memberId: string;
  readonly change: number;
}
