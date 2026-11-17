import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';

/**
 * Answers Settlements' `ISettlementMembers` port over Groups' read model, its Domain port `IGroupQueries` (CTX-CONTRACTS, ADR 10):
 * the members of a group in the order they joined, if the asking account is one of them. It is the one place Settlements reads
 * Groups, and only the read model's `membersOf`; Settlements' Domain never imports Groups. The read model is given as a function,
 * read when a request comes and not when the modules are built (ADR 7).
 */
export class SettlementMembersOfGroups implements ISettlementMembers {
  constructor(private readonly groups: () => Pick<IGroupQueries, 'membersOf'>) {}

  async membersOf(groupId: string, askedBy: string): Promise<string[] | undefined> {
    const members = await this.groups().membersOf(groupId, askedBy);
    return members?.map(member => member.memberId);
  }
}
