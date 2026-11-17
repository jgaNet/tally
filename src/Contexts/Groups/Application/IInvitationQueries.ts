/** What `GetInvitation` answers: the link as anyone who holds it reads it before joining (a read model, never an aggregate). */
export interface InvitationView {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}

/** The read side of the invitations. */
export interface IInvitationQueries {
  /** The invitation, with the name of the group it is to, or `undefined`. */
  invitationOf(id: string): Promise<InvitationView | undefined>;
}
