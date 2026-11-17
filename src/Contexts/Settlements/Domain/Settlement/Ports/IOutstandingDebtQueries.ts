/** A current member of a group who still owes, as Settlements counts it: what they owe, positive (request 18). */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  /** What the member still owes in the group, in the group's currency's cents: positive, never 0. */
  owes: number;
}

/**
 * The read side of what is still owed (ADR 10): read models, never aggregates (QUERY-READ-MODELS). Notifications' sweep reads
 * it through its own port, answered over this one. It counts every current member of every group: the balances as Ledger
 * counts them, the paid settlements already among them (ADR 8), with the payments waiting at the provider counted as paid.
 */
export interface IOutstandingDebtQueries {
  /** Every current member of every group who still owes, groups and members in the order they were read. */
  owing(): Promise<OutstandingDebt[]>;
}
