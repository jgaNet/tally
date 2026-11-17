import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's GroupMembers, answered over Groups' read model (docs/adr/0004): the members of a group, in the order they
 * joined, for a caller who is one of them. Translated here into Ledger's words: only the account ids are kept.
 */
export class GroupMembersOfGroups implements IGroupMembers {
  constructor(private readonly groups: IGroupQueries) {}

  async membersOf(callerId: string, groupId: string): Promise<string[] | undefined> {
    const members = await this.groups.listMembersOf(callerId, groupId);
    return members?.map(member => member.memberId);
  }
}
