/** A membership of a group as it is stored: the account, when it joined (the owner's is the group's creation), and when it left (null while it is a member). */
export interface MembershipSnapshot {
  accountId: string;
  joinedAt: string;
  leftAt: string | null;
}

/** A group as it is stored and reconstituted: plain values, its memberships in the order they joined, its version included. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  members: MembershipSnapshot[];
  createdAt: string;
  version: number;
}
