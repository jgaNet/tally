/** What a member has moved in the settlements of a group, in Ledger's words: their balance goes up by `amount` (docs/adr/0013). */
export interface SettledAmount {
  memberId: string;
  /** What the member paid in settlements less what they received: added to what is owed to them, or to what they owe. */
  amount: number;
}

/**
 * A settlement that counts in a group's balances, in Ledger's words (request 29, docs/adr/0028): who paid and who received it, how
 * much, how it was settled, and the instant the balances started to count it.
 */
export interface CountedSettlement {
  settlementId: string;
  payerId: string;
  payeeId: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  /** An instant, ISO 8601 in UTC: the moment the settlement was paid (in cash, when recorded). */
  countedFrom: string;
}

/**
 * What has been settled in a group, read when a balance is read (conventions/domain.yaml, the SettledAmounts link; docs/adr/0013).
 * Ledger owns the port, in its own words; Settlements answers it through an adapter in Ledger's Infrastructure, over Settlements'
 * read model. A balance never misses a settlement that is paid.
 */
export interface ISettledAmounts {
  settledOf(groupId: string): Promise<SettledAmount[]>;
  /**
   * Each settlement of the group that counts, with the instant it started to count (request 29, docs/adr/0028): read when a member's
   * statement is read, so a settlement is a line of it on the day it started to count.
   */
  countedOf(groupId: string): Promise<CountedSettlement[]>;
}
