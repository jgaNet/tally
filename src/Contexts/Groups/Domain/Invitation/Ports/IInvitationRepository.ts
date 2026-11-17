import { Id, IResult } from '@Architecture/Domain';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

export interface IInvitationRepository {
  /** The invitation of this id as it was read (its version), or null. */
  findById(id: Id): Promise<Invitation | null>;
  /** Stores the invitation at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(invitation: Invitation): Promise<IResult>;
}
