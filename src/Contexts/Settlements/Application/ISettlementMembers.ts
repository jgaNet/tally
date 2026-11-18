/**
 * The members of a group, as Settlements asks them (conventions/domain.yaml, ADR 9, the storm's `SettlementMembers`): a port
 * Settlements owns, in its own words, answered over Groups' roster. `membersOf` answers the group's current members' account
 * ids, in the order they joined, the earliest first; or `undefined` when there is no such group. `currencyOf` answers the
 * currency the group was created in (a code, EUR and the like), which a payment through the provider names (request 13), or
 * `undefined` when there is no such group. The adapter is Settlements' infrastructure over Groups' roster, so no domain imports Groups.
 */
export interface ISettlementMembers {
  membersOf(groupId: string): Promise<readonly string[] | undefined>;
  currencyOf(groupId: string): Promise<string | undefined>;
  /**
   * The account that owns the group, or `undefined` when there is no such group (request 38): the role a group's owner has, read through the
   * roster, is what decides who bears the provider fee.
   */
  ownerOf(groupId: string): Promise<string | undefined>;
  /**
   * Whether the group is archived (feature 27, request 27): nothing in it changes any more, so no settlement is recorded, requested,
   * refunded, or changed in it; a change is refused by the shared kernel's GroupArchived. A group that is not there answers `false`.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (feature 34, request 34): a suspended account records no cash settlement, asks no payment through the
   * provider, and asks no netting, in any group; each is refused by the shared kernel's AccountSuspended. An account that is not there answers `false`.
   */
  isSuspended(accountId: string): Promise<boolean>;
  /**
   * Whether the account is deleted (feature 35, request 35): a deleted account is paid through no provider and netted with no one, each
   * refused by the shared kernel's AccountDeleted; a cash settlement it receives is still recorded. An account that is not there answers `false`.
   */
  isDeleted(accountId: string): Promise<boolean>;
  /**
   * The groups two accounts are both members of now (feature 32, request 32), the earliest made first, each with its currency and
   * whether it is archived: what a netting reads to net what the two owe each other. A member who has left is not a member now.
   */
  groupsShared(accountId: string, otherId: string): Promise<SharedGroup[]>;
}

/** A group two accounts are both members of now, as a netting reads it: its id, its currency, and whether it is archived. */
export interface SharedGroup {
  readonly groupId: string;
  readonly currency: string;
  readonly archived: boolean;
}
