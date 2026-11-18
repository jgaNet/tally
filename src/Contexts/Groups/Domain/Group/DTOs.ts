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
 * A balance passed to the owner when a member left (request 20): the leaver's balance at the time, taken from `from` and given
 * to `to`, the owner. It is kept for good: a former member who joins again still has it counted, so its balance is 0 again.
 */
export interface PassageSnapshot {
  from: string;
  to: string;
  amount: number;
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
  /** The balances passed to the owner when members left, in the order they passed (request 20). */
  passages: PassageSnapshot[];
  createdAt: string;
  /** When the owner archived the group (an ISO string), or null or absent while it is open (request 27). */
  archivedAt?: string | null;
  version: number;
}
