import { Id } from '@Architecture/Domain';

import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's port to Groups, answered over Groups' read-model port (ADR 3): the ids the read model gives, translated into
 * Ledger's own words. The read model is the one Groups' wiring exports; Ledger never reaches into Groups' application.
 */
export class GroupMembersFromGroups implements IGroupMembers {
  constructor(private groups: IGroupMembersQueries) {}

  async membersOf(groupId: string): Promise<Id[]> {
    return (await this.groups.memberIdsOf(groupId)).map(memberId => new Id(memberId));
  }

  async isMember(groupId: string, accountId: Id): Promise<boolean> {
    return this.groups.isMemberOf(groupId, accountId.value);
  }
}
