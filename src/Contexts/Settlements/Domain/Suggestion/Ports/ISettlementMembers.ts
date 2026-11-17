/** A member of a group as Settlements needs it: the account only, in the order the members joined (docs/adr/0012). */
export interface SettlementMember {
  memberId: string;
}

/** A group as Settlements needs it to settle in it: its currency (fixed at its creation) and its current members, in the order they joined. */
export interface SettlementGroup {
  currency: string;
  members: SettlementMember[];
}

/**
 * Who may settle with whom, and in which currency, as Settlements needs it (conventions/domain.yaml, the Groups → Settlements link;
 * docs/adr/0012, docs/adr/0014): the group's current members in the order they joined, and its currency, answered over Groups'
 * read model. Settlements owns the port; Groups answers it through an adapter in Settlements' Infrastructure.
 */
export interface ISettlementMembers {
  /**
   * The group, when the caller is one of its current members: `undefined` otherwise, as if the group did not exist.
   */
  groupOf(callerId: string, groupId: string): Promise<SettlementGroup | undefined>;
}
