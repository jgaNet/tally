/**
 * The read-model port another context reads Ledger's balances through (ADR 4): what a member owes (a negative balance) or
 * is owed (a positive one) in a group, from the expenses recorded so far. 0 when nothing is recorded for the member. Read by
 * the command that decides, inside its own transaction, so it takes no lock.
 */
export interface IMemberBalancesQueries {
  balanceOf(groupId: string, memberId: string): Promise<number>;
  /**
   * Every member's balance in the group, one per member that has any (0 for the rest): read by Groups when it archives the group, to
   * decide that every balance is 0 (request 27), inside its transaction, so it takes no lock.
   */
  allBalancesOf(groupId: string): Promise<number[]>;
}
