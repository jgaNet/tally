import { Id } from '@Architecture/Domain';

import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { GroupRole, IGroupMembers, PassedBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * Ledger's port to Groups, answered over Groups' read model (ADR 3): the ids the read model gives, translated into
 * Ledger's own words. The read model is the one Groups' wiring exports; Ledger never reaches into Groups' application.
 * It is a function, because the two wiring files import each other (ADR 4): the read model is read when the port is asked.
 */
export class GroupMembersFromGroups implements IGroupMembers {
  constructor(private groups: () => IGroupMembersQueries) {}

  async membersOf(groupId: string): Promise<Id[]> {
    return (await this.groups().memberIdsOf(groupId)).map(memberId => new Id(memberId));
  }

  async archivedOf(groupId: string): Promise<boolean> {
    return this.groups().isArchivedOf(groupId);
  }

  async suspendedOf(accountId: Id): Promise<boolean> {
    return this.groups().isSuspendedOf(accountId.value);
  }

  async isMember(groupId: string, accountId: Id): Promise<boolean> {
    return this.groups().isMemberOf(groupId, accountId.value);
  }

  async roleOf(groupId: string, accountId: Id): Promise<GroupRole | null> {
    return this.groups().roleOf(groupId, accountId.value);
  }

  async hasBeenMember(groupId: string, accountId: Id): Promise<boolean> {
    return this.groups().hasBeenMemberOf(groupId, accountId.value);
  }

  async passedBalancesOf(groupId: string): Promise<PassedBalance[]> {
    return (await this.groups().passagesOf(groupId)).map(passage => ({
      from: new Id(passage.from),
      to: new Id(passage.to),
      amount: passage.amount,
    }));
  }
}
