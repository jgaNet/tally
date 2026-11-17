import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The groups, as aggregates, loaded and saved whole, with their members. A group is saved at the version it was loaded
 * at: a save over a newer one throws `ConcurrencyConflictException` (CONC-OPTIMISTIC, ADR 4).
 */
export interface IGroupRepository {
  /** Inserts a new group, with its owner as its first member. */
  insert(group: Group): Promise<void>;
  /** The group, as it is stored, or `undefined`. */
  get(id: string): Promise<Group | undefined>;
  /**
   * Stores the group's members as they now are, at the version it was loaded at, and the version after it: those who joined
   * since are inserted, those who left are removed (feature 9).
   */
  save(group: Group): Promise<void>;
}
