/** What an invitation is made of, as it is kept. The creation time is an ISO string, as the store keeps it. */
export interface InvitationSnapshot {
  id: string;
  groupId: string;
  invitedBy: string;
  createdAt: string;
}
