/** A member of a group as it is stored: the account, and when it joined (the owner's is the group's creation). */
export interface MembershipSnapshot {
  accountId: string;
  joinedAt: string;
}

/** A group as it is stored and reconstituted: plain values, its members in the order they joined, its version included. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  members: MembershipSnapshot[];
  createdAt: string;
  version: number;
}
