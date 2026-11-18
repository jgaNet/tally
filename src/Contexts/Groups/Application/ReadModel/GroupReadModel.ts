/** A group as one of its members reads it. */
export interface GroupReadModel {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  /** When the owner archived the group: present only once it is archived (request 27). */
  archivedAt?: string;
}
