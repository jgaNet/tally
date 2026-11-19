/** A member of a group who still owes `owed` (a whole number above 0) in it, with the payments waiting at the provider counted as paid. */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  owed: number;
  /** The group's currency: `owed` is a whole number of its minor unit (request 40). */
  currency: string;
}

/**
 * The read-model port another context reads what each member still owes through (ADR 10): one row for each current member of each
 * group who owes something, read by Notifications' sweep, outside any transaction. A member who owes nothing has no row.
 */
export interface IOutstandingDebtsQueries {
  outstanding(): Promise<OutstandingDebt[]>;
}
