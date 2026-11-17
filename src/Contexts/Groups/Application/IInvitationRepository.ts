import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

/** The invitations, as aggregates: issued once, read to be accepted, never changed after they are issued (ADR 4). */
export interface IInvitationRepository {
  insert(invitation: Invitation): Promise<void>;
  /** The invitation, as it is stored, or `undefined`. */
  get(id: string): Promise<Invitation | undefined>;
}
