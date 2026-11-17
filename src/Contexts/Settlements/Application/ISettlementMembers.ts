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
   * The current members of every group, as account ids, in no order: what the reminders of request 18 read through the debts
   * Settlements answers (`OutstandingDebts`). Asked by no member, so nothing is checked.
   */
  allMembers(): Promise<{ groupId: string; memberIds: string[] }[]>;
}
