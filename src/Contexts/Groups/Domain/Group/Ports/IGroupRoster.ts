import { GroupAuditEntry } from '@Contexts/Groups/Domain/Group/GroupAudit';

/**
 * The roster of groups, the read-model port Groups gives other contexts (conventions/domain.yaml, ADR 6): who is a member of
 * a group now, in the order they joined, the owner first, and the role each has in it. It answers the facts another context
 * needs in its own words and never an aggregate; a group that is not there answers `undefined`, which is the same answer for
 * everyone. Ledger reads it through an adapter of its own, when it decides who may be in a split and who may change an expense.
 */
export interface IGroupRoster {
  membersOf(groupId: string): Promise<RosterMember[] | undefined>;
  /** Whether the account is, or has been, a member of the group: a member who left keeps their statement (feature 9). */
  hasBeenMember(groupId: string, accountId: string): Promise<boolean>;
  /**
   * The ids of the groups the account is a member of now, the earliest made first (feature 37): a group it has left is not among them, nor
   * a group merged into another. An account in no group, or one that is not there, answers [].
   */
  groupsOf(accountId: string): Promise<string[]>;
  /** The currency the group was created in, as a code (EUR, USD, ...); a group that is not there answers `undefined` (feature 13). */
  currencyOf(groupId: string): Promise<string | undefined>;
  /**
   * Whether the group is archived (feature 27, request 27): nothing in it changes any more, and its members read it as before. A group that
   * is not there answers `false`, which callers never need: they have asked for its members first.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (feature 34, request 34): a suspended account starts no expense, recurring expense, cash settlement,
   * payment through the provider or netting, in any group, and each context refuses it by the shared kernel's AccountSuspended. An account that
   * is not there answers `false`.
   */
  isSuspended(accountId: string): Promise<boolean>;
  /**
   * Whether the account is deleted (feature 35, request 35): a deleted account is in no new split, paid through no provider, netted with no
   * one, and its recurring expenses end on their day, each context refusing it by the shared kernel's AccountDeleted. An account that is not
   * there answers `false`.
   */
  isDeleted(accountId: string): Promise<boolean>;
  /** The ids of every group there is, the earliest made first: what a sweep over all the groups reads (feature 18). */
  groupIds(): Promise<string[]>;
  /**
   * The balances that passed to the owner when members left the group, in the order they were made (request 20, ADR 15): each
   * leaver's balance, passed from them to the owner. Ledger counts them in every balance it reads; a group with no leaver answers [].
   */
  passedBalancesOf(groupId: string): Promise<PassedBalance[]>;
  /**
   * The audit entries of the balances that passed when members left (feature 28, ADR 23), the oldest first: what Ledger's audit reads
   * for the group. A group with no leaver answers [].
   */
  auditOf(groupId: string): Promise<GroupAuditEntry[]>;
}

/** A balance that passed from a member who left a group to its owner, in the group's currency's hundredths (ADR 15). */
export interface PassedBalance {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/** A member of a group as the roster answers it: the account, and its role in the group (the owner, or a member). */
export interface RosterMember {
  readonly memberId: string;
  readonly role: 'owner' | 'member';
}
