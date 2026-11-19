import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';

/**
 * Answers Settlements' `ISettlementMembers` port over Groups' read model, its Domain port `IGroupQueries` (CTX-CONTRACTS, ADR 10):
 * the members of a group in the order they joined, and its currency, if the asking account is one of them. It is the one place
 * Settlements reads Groups, and only the read model's `membersOf` and `groupOf`; Settlements' Domain never imports Groups. The read
 * model is given as a function, read when a request comes and not when the modules are built (ADR 7).
 */
export class SettlementMembersOfGroups implements ISettlementMembers {
  constructor(
    private readonly groups: () => Pick<
      IGroupQueries,
      'membersOf' | 'groupOf' | 'groupsOf' | 'currentMembers' | 'archivedOf'
    >,
  ) {}

  archivedOf(groupId: string): Promise<boolean> {
    return this.groups().archivedOf(groupId);
  }

  /**
   * The groups the asking member and the other are both in, read from the groups the asker is in, the earliest created first (Groups answers
   * the most recent first), each with its currency and whether it is archived (request 32).
   */
  async sharedGroupsOf(askedBy: string, other: string) {
    const groups = this.groups();
    const shared: { groupId: string; currency: string; archived: boolean }[] = [];
    for (const group of [...(await groups.groupsOf(askedBy))].reverse()) {
      const members = await groups.membersOf(group.id, askedBy);
      if (members?.some(member => member.memberId === other)) {
        shared.push({ groupId: group.id, currency: group.currency, archived: group.archivedAt !== undefined });
      }
    }
    return shared;
  }

  async membersOf(groupId: string, askedBy: string): Promise<string[] | undefined> {
    const members = await this.groups().membersOf(groupId, askedBy);
    return members?.map(member => member.memberId);
  }

  async currencyOf(groupId: string, askedBy: string): Promise<string | undefined> {
    return (await this.groups().groupOf(groupId, askedBy))?.currency;
  }

  allMembers(): Promise<{ groupId: string; memberIds: string[] }[]> {
    return this.groups().currentMembers();
  }
}
