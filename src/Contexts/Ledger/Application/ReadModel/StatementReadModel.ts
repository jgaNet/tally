/** What a statement entry always says: its date, what it is for, what the member paid, their share, and their balance once it is counted. */
interface StatementEntryBase {
  /** The day it is listed under: an expense's day, or a settlement's day in UTC when the balances started to count it. */
  date: string;
  description: string;
  /** What the member paid for it: an expense's amount when they are its payer, a settlement's amount when they pay it. 0 otherwise. */
  paid: number;
  /** The member's share of it: an expense's share, or a settlement's amount when they receive it. 0 otherwise. */
  share: number;
  /** The member's balance once this entry is counted, starting from 0. */
  balance: number;
}

/** One expense in a member's statement (request 8): its id, and what the member paid for it or owes for it. */
export interface StatementExpenseEntryReadModel extends StatementEntryBase {
  kind: 'expense';
  expenseId: string;
}

/** One settlement the balances count in a member's statement (request 29): its id, in cash or through the provider. */
export interface StatementSettlementEntryReadModel extends StatementEntryBase {
  kind: 'settlement';
  settlementId: string;
}

export type StatementEntryReadModel = StatementExpenseEntryReadModel | StatementSettlementEntryReadModel;

/** A member's statement as a member of the group reads it: the entries in the order of a bank statement, and the balance they end at. */
export interface StatementReadModel {
  memberId: string;
  /** The last entry's balance, or 0 when there is none: the balance the group's balances give the member, but for what passed to the owner (request 20). */
  balance: number;
  entries: StatementEntryReadModel[];
}
