import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { BalancePass, IGroupMembers, MemberOfGroup } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * Answers Ledger's `IGroupMembers` port over Groups' read model (CTX-CONTRACTS, ADR 5): the members of a group, in the order they
 * joined, with their roles, if the asking account is one of them; and the balances that passed to owners when members left (request
 * 20, ADR 16). It is the one place Ledger reads Groups, and only the read model's `membersOf` and `passesOf`; Ledger's Domain never
 * imports Groups. The wiring of this context gives it Groups' read side (`Contexts/Ledger/module.local.ts`).
 */
export class GroupMembersOfGroups implements IGroupMembers {
  /** Groups' read model is given as a function, read when a member is asked for and not when the modules are built (ADR 7). */
  constructor(
    private readonly groups: () => Pick<
      IGroupQueries,
      'membersOf' | 'passesOf' | 'archivedOf' | 'suspendedOf' | 'deletedOf' | 'groupsOf'
    >,
  ) {}

  async groupsOf(accountId: string): Promise<string[]> {
    return (await this.groups().groupsOf(accountId)).map(group => group.id);
  }

  async archivedOf(groupId: string): Promise<boolean> {
    return this.groups().archivedOf(groupId);
  }

  async suspendedOf(accountId: string): Promise<boolean> {
    return this.groups().suspendedOf(accountId);
  }

  async deletedOf(accountId: string): Promise<boolean> {
    return this.groups().deletedOf(accountId);
  }

  async membersOf(groupId: string, askedBy: string): Promise<MemberOfGroup[] | undefined> {
    const members = await this.groups().membersOf(groupId, askedBy);
    return members?.map(member => ({ memberId: member.memberId, role: member.role }));
  }

  async passesOf(groupId: string): Promise<BalancePass[]> {
    return this.groups().passesOf(groupId);
  }
}
