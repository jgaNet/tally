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
  /** Stores the group's new members, at the version it was loaded at, and the version after it. */
  save(group: Group): Promise<void>;
}
