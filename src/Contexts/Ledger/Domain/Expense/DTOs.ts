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
  recordedAt: string;
  version: number;
}
