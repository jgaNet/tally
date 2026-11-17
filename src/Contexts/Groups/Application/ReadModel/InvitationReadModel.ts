/** An invitation as anyone who holds its link reads it: the group it is to, and the member who invited. */
export interface InvitationReadModel {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}
