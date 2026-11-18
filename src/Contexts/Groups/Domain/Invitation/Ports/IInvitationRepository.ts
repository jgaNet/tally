import { IResult } from '@Architecture/Domain';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

/**
 * The store of invitations: loads and saves whole aggregates. Used inside a transaction only (docs/adr/0001).
 */
export interface IInvitationRepository {
  findById(id: string): Promise<Invitation | undefined>;
  /** Stores the invitation at version + 1; refuses it with a ConcurrencyConflict when the stored version is not the one read. */
  save(invitation: Invitation): Promise<IResult<undefined>>;
  /** Removes the invitations of a group that was merged into another: they let no one join it any more (request 31, docs/adr/0031). */
  removeOfGroup(groupId: string): Promise<void>;
}
