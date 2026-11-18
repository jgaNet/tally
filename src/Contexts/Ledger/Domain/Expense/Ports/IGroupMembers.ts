import { Id } from '@Architecture/Domain';

/** A member's role in a group: the owner, or a member who joined. */
export type GroupRole = 'owner' | 'member';

/** A balance passed to the group's owner when a member left (request 20): `amount` is the leaver's balance, taken from `from`. */
export interface PassedBalance {
  from: Id;
  to: Id;
  amount: number;
}

/**
 * Ledger's port to Groups, which it owns (ADR 3): who may be in a split, and who may change an expense. The ids of the
 * group's current members, in the order they joined; none when there is no such group. Answered by an adapter over
 * Groups' read model.
 */
export interface IGroupMembers {
  /**
   * Whether the group is archived (request 27): read by each command that would change something in it, inside its own transaction,
   * so it takes no lock; the command refuses by GroupArchived. Groups decides it and answers (ADR 18).
   */
  archivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether an administrator has suspended the account (request 34): read by each command an account starts, inside its transaction, so it takes
   * no lock; the command refuses by AccountSuspended. Groups decides it and answers.
   */
  suspendedOf(accountId: Id): Promise<boolean>;
  /**
   * Which of these accounts their person deleted (request 35), read by each command that splits with them, inside its transaction, so it takes
   * no lock; the command refuses by AccountDeleted, or ends the recurring expense they are in. Groups decides it and answers.
   */
  deletedAmong(accountIds: Id[]): Promise<Id[]>;
  /** The group's current members in join order, none when there is no such group: read by the command deciding a split. */
  membersOf(groupId: string): Promise<Id[]>;
  /** Whether the account is a current member of the group: read by a query, outside any transaction. */
  isMember(groupId: string, accountId: Id): Promise<boolean>;
  /**
   * The role of the account in the group, or null when it is not a member (or there is no such group): read by a command
   * deciding who may change an expense, inside its own transaction, so it takes no lock.
   */
  roleOf(groupId: string, accountId: Id): Promise<GroupRole | null>;
  /**
   * Whether the account has been a member of the group, now or before it left (ADR 4): a former member's statement is read
   * by the members of the group, and an expense of theirs is kept as it was. Read by a query, outside any transaction.
   */
  hasBeenMember(groupId: string, accountId: Id): Promise<boolean>;
  /**
   * The balances passed to the owner when members left, in the order they passed (request 20). A balance reads them: the leaver
   * gives up what it had, the owner takes it, so the balances of the group still add up to 0. Read inside a command's transaction
   * (no lock) or by a query.
   */
  passedBalancesOf(groupId: string): Promise<PassedBalance[]>;
}
