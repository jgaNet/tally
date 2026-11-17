import { IResult } from '@Architecture/Domain';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

/** The store of invitations as aggregates: loads and saves one. It never searches for a screen; that is IInvitationQueries. */
export interface IInvitationRepository {
  /** The invitation with this id, or null when there is none. */
  findById(id: string): Promise<Invitation | null>;
  /**
   * Stores a new invitation at version 1. An invitation already stored is refused with a ConcurrencyConflictException:
   * an invitation changes nothing once it exists (CONC-OPTIMISTIC).
   */
  save(invitation: Invitation): Promise<IResult>;
}
