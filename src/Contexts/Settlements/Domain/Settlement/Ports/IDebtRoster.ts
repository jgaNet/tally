/**
 * What every current member of every group still owes, as Settlements' read model gives it to Notifications' sweep (feature 18, ADR 14):
 * a port Settlements owns, answered over its own book and the read models it is given. `owes` is what the member still owes in the
 * group, in the group's currency's hundredths, never less than 0, with the payments waiting at the provider counted as paid; a member
 * who has left a group is not in it.
 */
export interface OwedDebt {
  readonly groupId: string;
  readonly memberId: string;
  readonly owes: number;
  /** The group's currency, a code of Tally's: `owes` is in its minor unit, so a reminder compares it with 20 of that currency (request 40). */
  readonly currency: string;
}

export interface IDebtRoster {
  debtsOf(): Promise<OwedDebt[]>;
}
