import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { IGroupMembers, MemberOfGroup } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * Answers Ledger's `IGroupMembers` port over Groups' read model (CTX-CONTRACTS, ADR 5): the members of a group, in the order
 * they joined, with their roles, if the asking account is one of them. It is the one place Ledger reads Groups, and only
 * the read model's `membersOf`; Ledger's Domain never imports Groups. The wiring of this context gives it Groups' read side
 * (`Contexts/Ledger/module.local.ts`).
 */
export class GroupMembersOfGroups implements IGroupMembers {
  constructor(private readonly groups: Pick<IGroupQueries, 'membersOf'>) {}

  async membersOf(groupId: string, askedBy: string): Promise<MemberOfGroup[] | undefined> {
    const members = await this.groups.membersOf(groupId, askedBy);
    return members?.map(member => ({ memberId: member.memberId, role: member.role }));
  }
}
