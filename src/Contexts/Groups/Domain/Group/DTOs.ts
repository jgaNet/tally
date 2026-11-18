import { CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';

/** A member of a group: an account, with its role, and when it joined. The members are kept in the order they joined. */
export interface MemberSnapshot {
  accountId: string;
  role: 'owner' | 'member';
  /** ISO 8601, UTC: when the account became a member (the owner's, when the group was created). */
  joinedAt: string;
  /**
   * ISO 8601, UTC: when the account left the group, when it has. A former member stays in the store, so that who has ever
   * been a member is known; it is not among the members (docs/adr/0009).
   */
  leftAt?: string;
  /**
   * The balance this account's leaves passed to the owner, cumulative (request 20, docs/adr/0019): the balance it had at each
   * leave, added up. It is kept on the membership, so that a member who joins again starts at 0. Absent when nothing passed.
   */
  passed?: number;
}

/** The state of a group as the store keeps it: what `Group.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: CurrencyCode;
  ownerId: string;
  /** ISO 8601, UTC: when the group was created. */
  createdAt: string;
  members: MemberSnapshot[];
  /**
   * ISO 8601, UTC: when the group was archived, when it has been (request 27, docs/adr/0026). Absent for a group that is not archived,
   * and once set it never changes.
   */
  archivedAt?: string;
  /** The version the group was read at: the store stores version + 1 on every save. */
  version: number;
}
