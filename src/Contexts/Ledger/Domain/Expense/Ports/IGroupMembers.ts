import { Id } from '@Architecture/Domain';

/**
 * Ledger's port to Groups, which it owns (ADR 3): who may be in a split. The ids of the group's current members, in the
 * order they joined; none when there is no such group. Answered by an adapter over Groups' read model.
 */
export interface IGroupMembers {
  /** The group's current members in join order, none when there is no such group: read by the command deciding a split. */
  membersOf(groupId: string): Promise<Id[]>;
  /** Whether the account is a current member of the group: read by a query, outside any transaction. */
  isMember(groupId: string, accountId: Id): Promise<boolean>;
}
