import { Id } from '@Architecture/Domain';

/**
 * Groups' port to Ledger, which Groups owns (ADR 4): the balance a member has in a group, which decides whether that
 * member may leave it. An integer, 0 when nothing is recorded for the member. Answered by an adapter over Ledger's
 * read model; read by the command deciding the leave, inside its own transaction, so it takes no lock.
 */
export interface IMemberBalances {
  balanceOf(groupId: string, accountId: Id): Promise<number>;
  /**
   * Every balance kept in the group, one per member (0 for a member with nothing recorded): read by the command archiving the group,
   * which is decided once they are all 0 (request 27). Read inside the command's transaction, so it takes no lock.
   */
  allBalancesOf(groupId: string): Promise<number[]>;
}
