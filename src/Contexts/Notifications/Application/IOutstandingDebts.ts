/** What a member still owes in a group, as the sweep needs it: a positive amount (request 18). */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  owed: number;
}

/**
 * What the members still owe, as Notifications' sweep needs it (request 18, ADR 15): a port Notifications owns, in its own words,
 * answered by an adapter over Settlements' read model (`OutstandingDebtsOfSettlements`, in this context's Infrastructure).
 * Settlements' Domain is never imported by the Application.
 */
export interface IOutstandingDebts {
  /**
   * What each current member of each group still owes, the payments waiting at the provider counted as paid, for the members who
   * owe something; a member who owes nothing, or who has left, is not in it. Read as one state, in no order.
   */
  outstandingDebts(): Promise<OutstandingDebt[]>;
}
