/**
 * A member's balance in a group, as Ledger has it (ADR 4): what Groups asks when a member wants to leave, and so a plain
 * value the aggregate decides on. Groups owns the port, in its own words; its adapter answers it over Ledger's read side.
 */
export interface IMemberBalances {
  /** The balance of this account in this group, 0 when nothing is recorded for it. */
  balanceOf(groupId: string, accountId: string): Promise<number>;
}
