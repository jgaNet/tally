/** What a signed-in person reads of an invitation: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface InvitationView {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}

/** The read side of the invitations' store: what the queries answer, read at once. */
export interface IInvitationQueries {
  /** The invitation, with the name of its group: undefined when there is no such invitation. Any signed-in person may read it. */
  findInvitation(id: string): Promise<InvitationView | undefined>;
}
