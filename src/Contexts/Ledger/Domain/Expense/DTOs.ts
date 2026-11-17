/** One member's share of an expense as it is stored. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/** An expense as it is stored and reconstituted: plain values, its shares in the order of the split, its version included. */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareSnapshot[];
  recordedAt: string;
  version: number;
}
