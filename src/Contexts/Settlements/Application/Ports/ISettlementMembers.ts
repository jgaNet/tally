/**
 * Settlements' port to Groups, which Settlements owns (ADR 6): who the members of a group are, in the words Settlements
 * decides with. Answered by an adapter over Groups' read model; read by the query that suggests the settlements.
 */
export interface ISettlementMembers {
  /** The ids of the group's current members in the order they joined, the earliest first; none when there is no such group. */
  membersOf(groupId: string): Promise<string[]>;
  /** Whether the account is a current member of the group. */
  isMemberOf(groupId: string, accountId: string): Promise<boolean>;
}
