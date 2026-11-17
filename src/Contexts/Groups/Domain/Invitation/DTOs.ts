/** The state of an invitation as the store keeps it: what `Invitation.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface InvitationSnapshot {
  id: string;
  groupId: string;
  /** The account of the member who made it. */
  invitedBy: string;
  /** ISO 8601, UTC: when the invitation was made. */
  createdAt: string;
  /** The version the invitation was read at: the store stores version + 1 on every save. */
  version: number;
}
