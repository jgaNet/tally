/** A member of a group as Settlements needs it: the account only, in the order the members joined (docs/adr/0012). */
export interface SettlementMember {
  memberId: string;
}

/**
 * Who may settle with whom, as Settlements needs it (conventions/domain.yaml, the Groups → Settlements link; docs/adr/0012): the
 * group's current members in the order they joined, answered over Groups' read model. Settlements owns the port; Groups answers it
 * through an adapter in Settlements' Infrastructure.
 */
export interface ISettlementMembers {
  /**
   * The current members of the group, in the order they joined, when the caller is one of them: `undefined` otherwise, as if the
   * group did not exist.
   */
  membersOf(callerId: string, groupId: string): Promise<SettlementMember[] | undefined>;
}
