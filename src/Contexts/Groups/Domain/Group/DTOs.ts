/** A member of a group, as persisted: the account, and when it joined. */
export interface IGroupMemberSnapshot {
  accountId: string;
  /** When the account joined, as an ISO 8601 string. */
  joinedAt: string;
}

/** A balance passed on when a member left, as persisted: the amount, from the member who left to the one who takes it over. */
export interface IBalancePassingSnapshot {
  from: string;
  to: string;
  amount: number;
}

/** The plain shape of a group that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IGroupSnapshot {
  _id: string;
  name: string;
  currency: string;
  ownerId: string;
  /** The current members in the order they joined: the owner first. */
  members: IGroupMemberSnapshot[];
  /** The accounts that were members and left, in the order they left. */
  formerMembers: IGroupMemberSnapshot[];
  /** The balances passed on when members left, in the order they were passed. */
  passings: IBalancePassingSnapshot[];
  /** When the group was created, as an ISO 8601 string. */
  createdAt: string;
  version: number;
}
