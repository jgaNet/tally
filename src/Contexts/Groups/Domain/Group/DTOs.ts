/** A member of a group, as persisted: the account, and when it joined. */
export interface IGroupMemberSnapshot {
  accountId: string;
  /** When the account joined, as an ISO 8601 string. */
  joinedAt: string;
}

/** The plain shape of a group that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IGroupSnapshot {
  _id: string;
  name: string;
  currency: string;
  ownerId: string;
  /** The members in the order they joined: the owner first. */
  members: IGroupMemberSnapshot[];
  /** When the group was created, as an ISO 8601 string. */
  createdAt: string;
  version: number;
}
