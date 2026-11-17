import { CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';

/** A member of a group: an account, with its role, and when it joined. The members are kept in the order they joined. */
export interface MemberSnapshot {
  accountId: string;
  role: 'owner' | 'member';
  /** ISO 8601, UTC: when the account became a member (the owner's, when the group was created). */
  joinedAt: string;
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
  /** The version the group was read at: the store stores version + 1 on every save. */
  version: number;
}
