/** What one current member of a group still owes in it, as a positive amount (OutstandingDebts, ADR 12). */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  owed: number;
}

/**
 * Who still owes what, in every group, asked by Notifications in its own words (OutstandingDebts, ADR 12): the sweep reads it
 * and decides on it. Notifications owns the port; its adapter answers it over Settlements' read side. A member who owes
 * nothing is not in it.
 */
export interface IOutstandingDebts {
  outstandingDebts(): Promise<OutstandingDebt[]>;
}
