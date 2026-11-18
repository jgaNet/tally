/** A member's role in a group, as Groups answers it: the owner, or any other member. */
export type MemberRole = 'owner' | 'member';

/** A current member of a group, as Ledger needs it to decide: the account's id and its role. */
export interface GroupMember {
  memberId: string;
  role: MemberRole;
}

/**
 * A balance a member passed on when they left a group (request 20): the amount, from the member who left to the one who
 * took it over, in Ledger's words. Ledger counts it when it reads the balances (ADR 11).
 */
export interface BalancePassing {
  from: string;
  to: string;
  amount: number;
}

/**
 * Ledger's own port onto Groups: who may be in a split, who may change an expense, and what passed to the owner when a
 * member left. Ledger asks it when it decides, in its own words; the adapter answers over Groups' read model (ADR 1, T3,
 * ADR 11). No domain imports Groups.
 */
export interface IGroupMembers {
  /**
   * The ids of the groups the account is a member of now, a former member's groups left out (request 37). It is read for the
   * account that asks, the person's own spending, and never answered to anyone else.
   */
  groupsOf(accountId: string): Promise<string[]>;
  /**
   * The balances passed on when members of the group left, in the order they were passed. It names no caller: Ledger reads
   * it when it counts a balance, and every balance is answered to a member only, by the handler that asks for it.
   */
  passingsOf(groupId: string): Promise<BalancePassing[]>;
  /**
   * The current members of a group, each with its role, in the order they joined, when `askedBy` is one of them; null
   * otherwise, as if the group did not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<GroupMember[] | null>;
  /**
   * The ids of the current members of a group, in the order they joined, for the background job, which names no caller: a
   * recurring expense's day is decided with the members as they are then (request 23). Never answered to a person.
   */
  currentMemberIds(groupId: string): Promise<string[]>;
  /**
   * Whether the account has ever been a member of the group, one who left included, when `askedBy` is a current member;
   * null otherwise, as if the group did not exist. A former member's statement is read through it (request 9).
   */
  hasBeenMember(groupId: string, accountId: string, askedBy: string): Promise<boolean | null>;
  /**
   * Whether the group is archived (request 27). It names no caller: a handler asks it once it has found the asker a member, and
   * the background job asks it for a recurring expense's group, never answered to a person.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (request 34). It names no caller: a handler asks it for the account that acts, once it has
   * found that account a member, and the background job asks it for a recurring expense's payer, never answered to a person.
   */
  isSuspended(accountId: string): Promise<boolean>;
  /**
   * Whether the account is deleted (request 35). It names no caller: a handler asks it for each account a new expense or recurring
   * expense lists, and the background job and the budget policy see the current members without the deleted ones.
   */
  isDeleted(accountId: string): Promise<boolean>;
}
