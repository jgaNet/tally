/**
 * The members of a group, as Settlements needs them to settle between them (request 11): a port Settlements owns, in its own
 * words, answered by an adapter over Groups' read model (`SettlementMembersOfGroups`, in this context's Infrastructure).
 * Groups' Domain is never imported by the Application.
 */
export interface ISettlementMembers {
  /**
   * The account ids of the members of the group, in the order they joined, the first to have joined first, if `askedBy` is
   * one of them; `undefined` when it is not, or the group is not there: to anyone else a group does not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<string[] | undefined>;
  /**
   * The currency of the group, the one a payment through the provider is made in, if `askedBy` is one of its members; `undefined`
   * when it is not, or the group is not there (as `membersOf`).
   */
  currencyOf(groupId: string, askedBy: string): Promise<string | undefined>;
  /**
   * The current members of every group, as account ids, in no order, with the group's currency: what the reminders of request 18 read through
   * the debts Settlements answers (`OutstandingDebts`), in the group's minor unit (request 40). Asked by no member, so nothing is checked.
   */
  allMembers(): Promise<{ groupId: string; memberIds: string[]; currency: string }[]>;
  /**
   * The groups `askedBy` and `other` are both current members of, the earliest created first, each with its currency and whether it is
   * archived (request 32): what a netting between the two reads. Asked by a member, and answered to no one else.
   */
  sharedGroupsOf(askedBy: string, other: string): Promise<{ groupId: string; currency: string; archived: boolean }[]>;
  /**
   * The account id of the group's owner, if the group is there and `askedBy` is one of its members (request 38): the owner alone decides who
   * bears the provider's fee. `undefined` when `askedBy` is not a member, or the group is not there (as `membersOf`).
   */
  ownerOf(groupId: string, askedBy: string): Promise<string | undefined>;
  /**
   * Whether the group is archived (request 27): then no settlement is recorded, asked for or refunded in it. Asked by no member: a settlement
   * asks it after the member is checked, and the answer is only the flag (ADR 24).
   */
  archivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (request 34): then it records no settlement in cash, asks for none through the provider, and asks for no
   * netting, in any group (ADR 32). Asked by no member: it is the answer about the account asking.
   */
  suspendedOf(accountId: string): Promise<boolean>;
  /**
   * Whether the account is deleted (request 35): then it is paid through the provider by no one and nets with no one (ADR 33), and a reminder of
   * a debt of it is not made. Asked by no member: it is the answer about an account.
   */
  deletedOf(accountId: string): Promise<boolean>;
}
