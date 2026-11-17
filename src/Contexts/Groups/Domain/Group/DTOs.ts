/** One member of a group as it is kept: the account, and when it joined (an ISO string, as the store keeps it). */
export interface MembershipSnapshot {
  accountId: string;
  joinedAt: string;
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
  createdAt: string;
  version: number;
}
