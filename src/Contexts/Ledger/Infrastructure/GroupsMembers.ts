import { Id } from '@Architecture/Domain';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { IGroupMembers, MemberRole } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** Answers Ledger's port from Groups' read side: the current members are the members Groups lists, and roles are Groups' roles (ADR 3). */
export class GroupsMembers implements IGroupMembers {
  constructor(private readonly groups: IGroupMembership) {}

  async currentMembers(groupId: Id): Promise<Id[]> {
    const members = await this.groups.listMemberIds(groupId.value);
    return members.map(member => new Id(member));
  }

  async roleOf(groupId: Id, accountId: Id): Promise<MemberRole | null> {
    return this.groups.roleOf(groupId.value, accountId.value);
  }

  async hasBeenMember(groupId: Id, accountId: Id): Promise<boolean> {
    return this.groups.hasBeenMember(groupId.value, accountId.value);
  }

  async balancesPassed(groupId: Id): Promise<Map<string, number>> {
    const passed = await this.groups.balancesPassed(groupId.value);
    const sums = new Map<string, number>();
    for (const { fromId, toId, amount } of passed) {
      sums.set(fromId, (sums.get(fromId) ?? 0) - amount);
      sums.set(toId, (sums.get(toId) ?? 0) + amount);
    }
    return sums;
  }
}
