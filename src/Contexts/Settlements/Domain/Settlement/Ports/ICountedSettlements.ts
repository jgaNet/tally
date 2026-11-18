/** A settlement the balances count, of a member's statement: who paid whom, how much, how it was made, and when the balances started to count it. */
export interface CountedSettlement {
  settlementId: string;
  payerId: string;
  payeeId: string;
  amount: number;
  method: 'cash' | 'provider';
  /** When the balances started to count it: its `paid` status (ADR 9, request 19), an ISO instant. */
  countedFrom: string;
}

/**
 * The settlements a member paid or received that the balances count (`paid` or `refunding`, ADR 7, ADR 9), each with when they
 * started to count, read from Settlements' own record for Ledger's statement (SettledAmounts). Settlements owns the answer;
 * Ledger asks it through its own port. A settlement that is refunded, or never paid, is not in it.
 */
export interface ICountedSettlements {
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}
