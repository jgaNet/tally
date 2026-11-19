/** A group two members share now, as Groups has it: its currency, and whether it is archived (request 32). */
export interface SharedGroup {
  groupId: string;
  currency: string;
  archived: boolean;
}

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
  /** The groups both accounts are members of now, the earliest created first, each with its currency and whether it is archived (request 32). */
  sharedGroups(first: string, second: string): Promise<SharedGroup[]>;
}
