/** What a member still owes in a group: a positive amount, in the group's currency's minor unit, and that currency (request 40). */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  currency: string;
  owed: number;
}

/**
 * The read side of what is still owed, for the reminders of request 18 (ADR 15): Notifications reads it through its own
 * `OutstandingDebts` port, answered by an adapter over this; nothing else of Settlements is reached for it.
 */
export interface IOutstandingDebtQueries {
  /**
   * What each current member of each group still owes, for the members who owe something: the ledger's balances with the settlements
   * paid and the payments waiting at the provider counted as paid (`stillOwed`, ADR 12). A member who owes nothing, or who has left,
   * is not in it.
   */
  outstandingDebts(): Promise<OutstandingDebt[]>;
}
