/** One member's share of an expense as a member reads it. */
export interface ExpenseShareReadModel {
  memberId: string;
  amount: number;
}

/** An expense as a member of its group reads it: its description, amount, day, payer and version, and the shares in split order. */
export interface ExpenseReadModel {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  /** The version it was last saved at: 1 when recorded, one more at each edit. */
  version: number;
  shares: ExpenseShareReadModel[];
}
