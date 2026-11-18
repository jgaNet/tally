/** The ways an expense is split, as an expense says it: equally between members, by exact amounts, or by shares. */
export const SPLIT_KINDS = ['equal', 'exact', 'shares'] as const;
export type SplitKind = (typeof SPLIT_KINDS)[number];

/** One member's share of an expense as it is stored. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/**
 * How an expense is split, as a command gives it: exactly one of the three. The transport refuses a body with none or
 * with more than one; the domain refuses a request with none or more than one too, by name.
 */
export interface SplitRequest {
  /** An equal split: the members it is between, the payer among them, in the order given. */
  splitBetween?: readonly string[];
  /** Each member with the exact amount of their share, the payer among them. */
  splitExactly?: readonly { memberId: string; amount: number }[];
  /** Each member with a whole number of shares, the payer among them. */
  splitByShares?: readonly { memberId: string; shares: number }[];
}

/** What an expense was paid in another currency, as a command gives it: the currency, the amount in its hundredths, and the rate. */
export interface OriginalRequest {
  currency: string;
  amount: number;
  /**
   * What one of that currency is worth in the group's currency, written as a decimal string, as the payer states it; left
   * out, the rate offered for its day is taken (request 22, ADR 15).
   */
  rate?: string;
}

/** An expense as it is stored and reconstituted: plain values, its shares in the order of the split, its version included. */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  splitKind: SplitKind;
  shares: ShareSnapshot[];
  /** What it was paid in, when it was not in the group's currency; null otherwise. */
  original: { currency: string; amount: number; rate: string } | null;
  recordedAt: string;
  version: number;
}
