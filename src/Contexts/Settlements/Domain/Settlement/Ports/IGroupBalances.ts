/**
 * A group's balances, as Ledger has them, asked by Settlements in its own words (GroupBalances, ADR 5): what a suggested
 * settlement is made from. Settlements owns the port; its adapter answers it over Ledger's balance read side.
 */
export interface IGroupBalances {
  /** The balance of each member of the group with one recorded, as a map from member id to balance; a member not in it is at 0. */
  balancesOf(groupId: string): Promise<Map<string, number>>;
  /** The groups that have any balance recorded, so that every debt of every group can be asked for (ADR 12). */
  groupIds(): Promise<string[]>;
}
