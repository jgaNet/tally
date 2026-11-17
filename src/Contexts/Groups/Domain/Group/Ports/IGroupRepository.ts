import { Id, IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

export interface IGroupRepository {
  /** The group under this id, with its members, or null. */
  findById(id: Id): Promise<Group | null>;
  /**
   * Stores a new group under the id it was born with, or a changed one at its version + 1, with its members. It fails
   * with a ConcurrencyConflictException when the group is no longer at the version it was read at. It runs in the
   * command's transaction.
   */
  save(group: Group): Promise<IResult>;
}
