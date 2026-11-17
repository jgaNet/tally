/** One expense in a member's statement: what the member paid for it, their share of it, and their balance once it is counted. */
export interface StatementEntryReadModel {
  expenseId: string;
  date: string;
  description: string;
  /** What the member paid for it: its amount when they are its payer, 0 otherwise. */
  paid: number;
  /** The member's share of it: 0 when they are not in its split. */
  share: number;
  /** The member's balance once this entry is counted, starting from 0. */
  balance: number;
}

/** A member's statement as a member of the group reads it: the entries in the order of a bank statement, and the balance they end at. */
export interface StatementReadModel {
  memberId: string;
  /** The last entry's balance, or 0 when there is none: the balance the group's balances give the member. */
  balance: number;
  entries: StatementEntryReadModel[];
}
