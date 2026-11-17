import { Id } from '@Architecture/Domain';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** Answers Ledger's port from Groups' read side: the current members are the members Groups lists (ADR 3). */
export class GroupsMembers implements IGroupMembers {
  constructor(private readonly groups: IGroupMembership) {}

  async currentMembers(groupId: Id): Promise<Id[]> {
    const members = await this.groups.listMemberIds(groupId.value);
    return members.map(member => new Id(member));
  }
}
