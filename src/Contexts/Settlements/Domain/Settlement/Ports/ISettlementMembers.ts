/**
 * The members of a group as Groups has them now, asked by Settlements in its own words (SettlementMembers, ADR 5): who
 * may settle with whom, and the order they joined, which breaks a tie in a suggestion. Its adapter answers it over
 * Groups' read side.
 */
export interface ISettlementMembers {
  /** The account ids of the group's members now, in the order they joined, the earliest first; empty for a group that does not exist. */
  currentMembers(groupId: string): Promise<string[]>;
  /** Whether the group is archived (request 27, ADR 20): a change in an archived group is refused by GroupArchived. */
  isArchived(groupId: string): Promise<boolean>;
}
