import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { GroupMember, IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's port onto Groups, answered over Groups' read model: the members of a group, in the order they joined, with
 * their role, as Ledger's own words for them (account ids). Membership of the asker is the read model's to say.
 */
export class GroupsMembership implements IGroupMembers {
  constructor(private groups: IGroupQueries) {}

  async membersOf(groupId: string, askedBy: string): Promise<GroupMember[] | null> {
    const members = await this.groups.listMembersOf(askedBy, groupId);
    return members ? members.map(member => ({ memberId: member.memberId, role: member.role })) : null;
  }
}
