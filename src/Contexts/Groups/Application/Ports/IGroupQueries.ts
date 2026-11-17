import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';

export interface IGroupQueries {
  /** The group with this id, when this account is one of its members; null for anyone else, as if it did not exist. */
  findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null>;
  /** The groups this account is a member of, the most recently created first. */
  listForMember(accountId: string): Promise<GroupReadModel[]>;
  /**
   * The members of the group in the order they joined, the owner first, when this account is one of them; null for
   * anyone else, as if the group did not exist.
   */
  listMembers(groupId: string, accountId: string): Promise<MemberReadModel[] | null>;
}
