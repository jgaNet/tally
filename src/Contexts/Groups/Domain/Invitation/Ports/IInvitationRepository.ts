import { Id, IResult } from '@Architecture/Domain';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

export interface IInvitationRepository {
  /** The invitation under this id, or null. */
  findById(id: Id): Promise<Invitation | null>;
  /** Stores a new invitation under the id it was born with. It runs in the command's transaction. */
  save(invitation: Invitation): Promise<IResult>;
}
