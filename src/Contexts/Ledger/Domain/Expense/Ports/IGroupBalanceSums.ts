/**
 * The balances of a group as Ledger reads them from its balance entries (ADR 5): the read side Settlements asks through its
 * own port (GroupBalances). A member with nothing recorded is absent from the map (0); the balances of a group sum to 0.
 * It is read outside any transaction, in one statement, so it never sees an expense half-written.
 */
export interface IGroupBalanceSums {
  sumsByMember(groupId: string): Promise<Map<string, number>>;
  /** The groups that have a balance entry, that is, every group with an expense recorded; a group with none has no balance to read. */
  groupIds(): Promise<string[]>;
}
