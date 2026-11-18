/**
 * What one current member of a group still owes in it, in the group's currency's minor unit; 0 when nothing is owed. The currency is the
 * group's code, which says what the minor unit is, and so what 20 of the currency is a reminder is for (request 40).
 */
export interface OutstandingDebt {
  readonly groupId: string;
  readonly memberId: string;
  readonly owes: number;
  readonly currency: string;
}

/**
 * What every current member of every group still owes (feature 18, the storm's `OutstandingDebts`): a port Notifications owns, in its own
 * words, answered by an adapter over Settlements' read model. The payments waiting at the provider count as paid, and a member who has
 * left a group is not in it. The sweep reads it once per run; a read answers what is kept and changes nothing.
 */
export interface IOutstandingDebts {
  debtsOf(): Promise<OutstandingDebt[]>;
}
