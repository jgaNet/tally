import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';

export interface IGroupQueries {
  /** The group with this id, when this account is one of its members; null for anyone else, as if it did not exist. */
  findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null>;
  /** The groups this account is a member of, the most recently created first. */
  listForMember(accountId: string): Promise<GroupReadModel[]>;
}
