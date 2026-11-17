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
}
