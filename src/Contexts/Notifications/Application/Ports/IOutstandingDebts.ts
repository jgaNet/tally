/** A current member of a group who still owes `owed` (a whole number above 0) in it, with the payments waiting at the provider counted as paid. */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  owed: number;
}

/**
 * Notifications' port to Settlements, which Notifications owns (ADR 10): what each current member of each group still owes, in
 * the words the sweep decides with. Answered by an adapter over Settlements' read model, and read by the sweep, outside any
 * transaction.
 */
export interface IOutstandingDebts {
  outstanding(): Promise<OutstandingDebt[]>;
}
