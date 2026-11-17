import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';

export interface IGroupQueries {
  /** The group of this id, if this account is one of its members; null otherwise, as if it did not exist. */
  findForMember(id: string, accountId: string): Promise<GroupReadModel | null>;
  /** The groups this account is a member of, the most recently created first. */
  listForMember(accountId: string): Promise<GroupReadModel[]>;
}
