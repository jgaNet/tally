/**
 * A member's balance in a group, read from Ledger's balance entries (ADR 4): what Groups asks when a member leaves. It is
 * read inside the asking command's transaction, so it sees what that transaction sees; 0 for a member with nothing recorded.
 */
export interface IMemberBalanceSums {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
