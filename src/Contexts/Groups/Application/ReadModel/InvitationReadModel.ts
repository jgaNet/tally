/** What a signed-in person reads of an invitation before joining: the group it leads to, and who invited them. */
export interface InvitationReadModel {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}
