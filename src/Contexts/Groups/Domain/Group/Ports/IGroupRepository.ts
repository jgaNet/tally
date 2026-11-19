import { IResult } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The store of groups: loads and saves whole aggregates. Used inside a transaction only (docs/adr/0001).
 */
export interface IGroupRepository {
  findById(id: string): Promise<Group | undefined>;
  /** Stores the group at version + 1; refuses it with a ConcurrencyConflict when the stored version is not the one read. */
  save(group: Group): Promise<IResult<undefined>>;
  /**
   * Removes a group that was merged into another (request 31, docs/adr/0031): its memberships and the group itself, if it is still at the
   * version it was read at; a conflict otherwise. Once removed it is not found, by anyone.
   */
  remove(group: Group): Promise<IResult<undefined>>;
  /**
   * Whether the account owns a group in which another person is a current member (request 35, docs/adr/0035): the fact the deletion of the
   * account needs about the collection of groups.
   */
  ownsGroupWithOtherMembers(accountId: string): Promise<boolean>;
  /** Moves the balances that passed to the owner from a merged group to the group kept, as the group's audit keeps them (docs/adr/0031). */
  movePassedBalances(fromGroupId: string, intoGroupId: string): Promise<void>;
}
