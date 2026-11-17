/** One member's share of an expense, as it is kept. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/**
 * What an expense is made of, as it is kept: its amount and its day, the payer, and each member's share in the order the
 * split was given. Its id is the one it was born with.
 */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareSnapshot[];
}
