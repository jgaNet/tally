/** What has been settled for one member of a group: the change the group's settlements make to the member's balance. */
export interface SettledAmount {
  memberId: string;
  /** Positive when the member paid settlements (their balance goes up), negative when they received some. */
  amount: number;
}

/** One settlement a member pays or receives that the balances count, as the member's statement lists it (request 29). */
export interface CountedSettlement {
  settlementId: string;
  method: 'cash' | 'provider';
  payer: string;
  payee: string;
  amount: number;
  /** The instant the balances started to count it, as an ISO instant. */
  countedFrom: string;
}

/**
 * Ledger's port to Settlements, which Ledger owns (ADR 7): what has been settled in a group, per member, read when a balance
 * is read, so that a balance counts a settlement as soon as it is recorded, with no copy of it here. Answered by an adapter
 * over Settlements' read model.
 *
 * `countedOf` answers the settlements of one member that the balances count, each with when it started to count (ADR 20): a
 * member's statement reads them, in the same read model, and copies none of them either.
 */
export interface ISettledAmounts {
  settledOf(groupId: string): Promise<SettledAmount[]>;
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
}
