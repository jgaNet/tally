import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The store of groups: loads and saves whole aggregates. Used inside a transaction only (docs/adr/0001).
 */
export interface IGroupRepository {
  findById(id: string): Promise<Group | undefined>;
  /** Stores the group at version + 1; refuses it with a ConcurrencyConflict when the stored version is not the one read. */
  save(group: Group): Promise<IResult<undefined>>;
}
