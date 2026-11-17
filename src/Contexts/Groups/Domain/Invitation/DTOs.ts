/** An invitation as it is stored and reconstituted: plain values, its version included. */
export interface InvitationSnapshot {
  id: string;
  groupId: string;
  invitedBy: string;
  createdAt: string;
  version: number;
}
