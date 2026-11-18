import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { BalancePassing, GroupMember, IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's port onto Groups, answered over Groups' read model: the members of a group, in the order they joined, with
 * their role, as Ledger's own words for them (account ids), and the balances passed on when members left (ADR 11).
 * Membership of the asker is the read model's to say.
 */
export class GroupsMembership implements IGroupMembers {
  constructor(private groups: IGroupQueries) {}

  async passingsOf(groupId: string): Promise<BalancePassing[]> {
    const passings = await this.groups.passingsOf(groupId);
    return passings.map(passing => ({ from: passing.from, to: passing.to, amount: passing.amount }));
  }

  async membersOf(groupId: string, askedBy: string): Promise<GroupMember[] | null> {
    const members = await this.groups.listMembersOf(askedBy, groupId);
    return members ? members.map(member => ({ memberId: member.memberId, role: member.role })) : null;
  }

  async currentMemberIds(groupId: string): Promise<string[]> {
    const memberships = await this.groups.membersOfEveryGroup();
    return memberships.filter(membership => membership.groupId === groupId).map(membership => membership.memberId);
  }

  hasBeenMember(groupId: string, accountId: string, askedBy: string): Promise<boolean | null> {
    return this.groups.hasBeenMemberOf(askedBy, groupId, accountId);
  }
}
