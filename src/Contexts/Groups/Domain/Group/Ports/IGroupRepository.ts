import { Id, IResult } from '@Architecture/Domain';
import { Group } from '@Contexts/Groups/Domain/Group/Group';

export interface IGroupRepository {
  /** The group of this id as it was read (its version), or null. */
  findById(id: Id): Promise<Group | null>;
  /** Stores the group at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(group: Group): Promise<IResult>;
}
