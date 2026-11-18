/**
 * What the settlements of a group paid do to each member's balance, as Settlements records them (SettledAmounts, ADR 7):
 * a payer's balance goes up by what they paid, a payee's goes down by what they received. Ledger owns the port and asks it
 * when it reads a balance; its adapter answers it over Settlements' read side. A member with no settlement is absent (0).
 *
 * `countedOf` answers the same settlements one by one, for a member's statement (request 29): each with who paid whom, how
 * much, how it was made, and when the balances started to count it. A settlement is counted from its `paid` status.
 */
export interface ISettledAmounts {
  settledByMember(groupId: string): Promise<Map<string, number>>;
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}

/** A settlement the balances count, as a member's statement reads it. */
export interface CountedSettlement {
  settlementId: string;
  payerId: string;
  payeeId: string;
  amount: number;
  method: 'cash' | 'provider';
  /** When the balances started to count it, an ISO instant. */
  countedFrom: string;
}
