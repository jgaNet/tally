/** A group as it is stored and reconstituted: plain values, its members in the order they joined, its version included. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  memberIds: string[];
  createdAt: string;
  version: number;
}
