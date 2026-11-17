import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The store of groups: saves whole aggregates. Used inside a transaction only (docs/adr/0001). Its methods are added
 * with the features that load a group.
 */
export interface IGroupRepository {
  /** Stores the group at version + 1; refuses it with a ConcurrencyConflict when the stored version is not the one read. */
  save(group: Group): Promise<IResult<undefined>>;
}
