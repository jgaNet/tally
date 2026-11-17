/** The plain shape of an invitation that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IInvitationSnapshot {
  _id: string;
  groupId: string;
  /** The member who created the invitation. */
  invitedBy: string;
  version: number;
}
