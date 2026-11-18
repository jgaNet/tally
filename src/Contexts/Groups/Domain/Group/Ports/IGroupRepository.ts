import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The store of groups as aggregates: loads and saves one. It never searches for a screen; that is IGroupQueries.
 */
export interface IGroupRepository {
  /** The group with this id, or null when there is none. */
  findById(id: string): Promise<Group | null>;
  /**
   * Stores the group at the version it was read at plus one. A group no longer at the stored version is refused
   * with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  save(group: Group): Promise<IResult>;
  /**
   * Whether the account owns a group that has another member, one of any kind, archived or not: the fact an account's deletion
   * needs about the collection (request 35). It names no caller; the handler asks it for the account that acts.
   */
  hasOwnedGroupWithOtherMembers(ownerId: string): Promise<boolean>;

  /**
   * Stores the group kept at the version it was read at plus one, and makes the group merged gone in the same transaction: its
   * row, its members and its passed balances are removed at the version it was read at, and its audit entries are the group
   * kept's (request 31). A group no longer at the stored version is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  absorb(kept: Group, merged: Group): Promise<IResult>;
}
