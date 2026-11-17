/**
 * The read-model port another context reads Ledger's balances through (ADR 4): what a member owes (a negative balance) or
 * is owed (a positive one) in a group, from the expenses recorded so far. 0 when nothing is recorded for the member. Read by
 * the command that decides, inside its own transaction, so it takes no lock.
 */
export interface IMemberBalancesQueries {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
