import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { GroupMember, IGroupMembers, PassedBalances } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's GroupMembers, answered over Groups' read model (docs/adr/0004, docs/adr/0006): the members of a group, in the
 * order they joined, with their roles, for a caller who is one of them. Translated here into Ledger's words: the account
 * ids and the role, nothing else of a member.
 */
export class GroupMembersOfGroups implements IGroupMembers {
  constructor(private readonly groups: IGroupQueries) {}

  async membersOf(callerId: string, groupId: string): Promise<GroupMember[] | undefined> {
    const members = await this.groups.listMembersOf(callerId, groupId);
    return members?.map(({ memberId, role }) => ({ memberId, role }));
  }

  async hasBeenMember(groupId: string, memberId: string): Promise<boolean> {
    return this.groups.everMemberOf(memberId, groupId);
  }

  async currentMemberIds(groupId: string): Promise<string[]> {
    return this.groups.currentMemberIdsOf(groupId);
  }

  async currentGroupIdsOf(accountId: string): Promise<string[]> {
    return (await this.groups.listGroupsOf(accountId)).map(group => group.id);
  }

  async isArchived(groupId: string): Promise<boolean> {
    return this.groups.isArchived(groupId);
  }

  async isSuspended(accountId: string): Promise<boolean> {
    return this.groups.isSuspended(accountId);
  }

  async isDeleted(accountId: string): Promise<boolean> {
    return this.groups.isDeleted(accountId);
  }

  async passedBalancesOf(groupId: string): Promise<PassedBalances | undefined> {
    const passed = await this.groups.passedBalancesOf(groupId);
    return passed && { ownerId: passed.ownerId, members: passed.members.map(member => ({ ...member })) };
  }
}
