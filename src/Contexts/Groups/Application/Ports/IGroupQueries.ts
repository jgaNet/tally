import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';

export interface IGroupQueries {
  /** The group of this id, if this account is one of its members; null otherwise, as if it did not exist. */
  findForMember(id: string, accountId: string): Promise<GroupReadModel | null>;
  /** The groups this account is a member of, the most recently created first. */
  listForMember(accountId: string): Promise<GroupReadModel[]>;
  /** The members of a group in the order they joined, the owner first. */
  listMembers(groupId: string): Promise<MemberReadModel[]>;
}
