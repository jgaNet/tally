import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

/** What a screen shows of one invitation: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface InvitationView {
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly invitedBy: string;
}

/**
 * The store of invitations, the port the use cases write and read through. An invitation is never changed once made, so
 * the store only adds it and finds it. `viewOf` answers the invitation with the name of its group, to anyone who holds its
 * id: the link is the proof, so the store does not filter by membership.
 */
export interface IInvitationStore {
  add(invitation: Invitation): Promise<void>;
  findById(invitationId: string): Promise<Invitation | undefined>;
  viewOf(invitationId: string): Promise<InvitationView | undefined>;
}
