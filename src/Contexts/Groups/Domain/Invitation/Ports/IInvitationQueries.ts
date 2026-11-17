/** What a signed-in person reads of an invitation before joining: the group it invites to, and who invited them. */
export interface InvitationView {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}

/** The read side of invitations: a read model, never an aggregate (QUERY-READ-MODELS). */
export interface IInvitationQueries {
  /** The invitation with this id, with its group's name, or null when there is none. Membership is not asked: the link is the proof. */
  findInvitation(id: string): Promise<InvitationView | null>;
}
