/** A member of a group as Settlements needs it: the account only, in the order the members joined (docs/adr/0012). */
export interface SettlementMember {
  memberId: string;
}

/**
 * A group as Settlements needs it to settle in it: its currency (fixed at its creation), its owner (request 38: the one who decides who bears
 * the provider's fee), its current members, in the order they joined, and whether it is archived (request 27): an archived group takes no
 * settlement.
 */
export interface SettlementGroup {
  currency: string;
  ownerId: string;
  members: SettlementMember[];
  archived: boolean;
}

/** A group two members are both current members of, with its id, as a netting reads it (request 32). */
export interface SharedSettlementGroup extends SettlementGroup {
  groupId: string;
}

/**
 * Who may settle with whom, and in which currency, as Settlements needs it (conventions/domain.yaml, the Groups → Settlements link;
 * docs/adr/0012, docs/adr/0014, docs/adr/0032): the group's current members in the order they joined, and its currency, answered over
 * Groups' read model. Settlements owns the port; Groups answers it through an adapter in Settlements' Infrastructure.
 */
export interface ISettlementMembers {
  /**
   * The group, when the caller is one of its current members: `undefined` otherwise, as if the group did not exist.
   */
  groupOf(callerId: string, groupId: string): Promise<SettlementGroup | undefined>;
  /**
   * The groups both accounts are current members of, in the given currency, the earliest created first (request 32, docs/adr/0032).
   * Archived ones are listed too, with their flag: a netting leaves them out. Answered for the caller only, as the caller's groups.
   */
  sharedGroupsOf(callerId: string, withId: string, currency: string): Promise<SharedSettlementGroup[]>;
  /**
   * Whether the account is suspended (request 34, docs/adr/0034): a suspended account records no cash settlement, asks no provider
   * payment and asks no netting. Groups answers it.
   */
  isSuspended(accountId: string): Promise<boolean>;
  /**
   * Whether the account was deleted (request 35, docs/adr/0035): a deleted account is paid through no provider, is netted with by no one,
   * and is told of no debt. Groups answers it.
   */
  isDeleted(accountId: string): Promise<boolean>;
}
