/** A membership of a group as it is stored: the account, when it joined (the owner's is the group's creation), and when it left (null while it is a member). */
export interface MembershipSnapshot {
  accountId: string;
  joinedAt: string;
  leftAt: string | null;
}

/** A balance that passed from a member who left to the owner of the group, as it is stored: the amount, and when. */
export interface PassedBalanceSnapshot {
  fromId: string;
  toId: string;
  amount: number;
  passedAt: string;
  /**
   * The key the balance was born with, `<group>:<position>`, when it was born in another group and came here by a merge
   * (request 31): it keeps its id in the audit. Absent or null for a balance that passed in this group.
   */
  origin?: string | null;
}

/** A group as it is stored and reconstituted: plain values, its memberships in the order they joined, its version included. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  members: MembershipSnapshot[];
  /** The balances that passed to the owner when a member left, the earliest first: facts, never changed. */
  passed: PassedBalanceSnapshot[];
  createdAt: string;
  /** When the group was archived, absent or null while it is not (request 27). */
  archivedAt?: string | null;
  /** The group this one was merged into, once it is (request 31): it no longer exists, and its repository forgets it. */
  mergedInto?: string | null;
  version: number;
}
