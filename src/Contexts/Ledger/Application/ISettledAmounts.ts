/**
 * What was settled in a group, as Ledger needs it to read a balance (ADR 11): a port Ledger owns, in its own words, answered by an
 * adapter over Settlements' read model (`SettledAmountsOfSettlements`, in the wiring of this context). Settlements' Domain is never
 * imported by the Application.
 */
export interface ISettledAmounts {
  /**
   * The net effect of the group's settlements on each member's balance: a payer's amount goes up by what they paid, a payee's goes
   * down by it, so the map adds up to 0. A member not in the map has 0. One state of the group's settlements, read in one statement.
   */
  settledOf(groupId: string): Promise<ReadonlyMap<string, number>>;
}
