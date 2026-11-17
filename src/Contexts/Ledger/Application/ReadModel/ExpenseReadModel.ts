/** One member's share of an expense, as a member reads it. */
export interface ShareReadModel {
  memberId: string;
  amount: number;
}

/** An expense as a member of its group reads it: what it was for, what it cost, when, who paid, each share, and its version. */
export interface ExpenseReadModel {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareReadModel[];
  /** 1 when it is recorded, one more at each edit: the version an edit is made from. */
  version: number;
}
