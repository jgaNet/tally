/** One member of a group as it is kept: the account, and when it joined (an ISO string, as the store keeps it). */
export interface MembershipSnapshot {
  accountId: string;
  joinedAt: string;
}

/** A member who left a group: kept, so that the expenses they were in can still say who they were (ADR 4). */
export interface DepartureSnapshot extends MembershipSnapshot {
  leftAt: string;
}

/**
 * What a group is made of, as it is kept. The creation time is an ISO string, as the store keeps it; `version` is the
 * one the group was read at, and `members` are in the order they joined, the owner first.
 */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  members: MembershipSnapshot[];
  /** The members who left, in no particular order; none of them is among `members` (ADR 4). */
  departed: DepartureSnapshot[];
  createdAt: string;
  version: number;
}
