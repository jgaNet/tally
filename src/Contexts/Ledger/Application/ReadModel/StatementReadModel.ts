/** One expense a member's statement lists: what the member paid for it, their share of it, and their balance once it is counted. */
export interface StatementEntryReadModel {
  expenseId: string;
  date: string;
  description: string;
  /** What the member paid for it: its amount when they are its payer, 0 otherwise. */
  paid: number;
  /** The member's share of it: 0 when they are not in its split. */
  share: number;
  /** The member's balance once this entry is counted, from 0 at the start of the statement. */
  balance: number;
}

/** A member's statement in a group: the entries in the order of a bank statement, and the balance the last one leaves (0 when there are none). */
export interface StatementReadModel {
  memberId: string;
  balance: number;
  entries: StatementEntryReadModel[];
}

/** An expense of a member's statement before the balance is counted: the same fields, without the balance. */
export type StatementLine = Omit<StatementEntryReadModel, 'balance'>;
