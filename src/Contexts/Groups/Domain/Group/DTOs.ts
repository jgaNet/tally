/** What a group is made of, as it is kept. The creation time is an ISO string, as the store keeps it. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  memberIds: string[];
  createdAt: string;
}
