import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';

export interface IInvitationQueries {
  /** The invitation with this id, with the name of its group, or null. Anyone who holds the link reads it. */
  findById(invitationId: string): Promise<InvitationReadModel | null>;
}
