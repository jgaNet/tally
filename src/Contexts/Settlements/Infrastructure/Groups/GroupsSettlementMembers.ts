import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import {
  ISettlementMembers,
  SettlementMember,
  SharedGroup,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';

/**
 * Settlements' port onto Groups, answered over Groups' read model: the current members of a group, in the order they
 * joined, and its currency, as Settlements' own words for them (ADR 7). Membership of the asker is the read model's to say.
 */
export class GroupsSettlementMembers implements ISettlementMembers {
  constructor(private groups: IGroupQueries) {}

  async membersOf(groupId: string, askedBy: string): Promise<SettlementMember[] | null> {
    const members = await this.groups.listMembersOf(askedBy, groupId);
    return members ? members.map(({ memberId }) => ({ memberId })) : null;
  }

  async ownerOf(groupId: string, askedBy: string): Promise<string | null> {
    const group = await this.groups.findGroupOf(askedBy, groupId);
    return group ? group.ownerId : null;
  }

  async currencyOf(groupId: string, askedBy: string): Promise<string | null> {
    const group = await this.groups.findGroupOf(askedBy, groupId);
    return group ? group.currency : null;
  }

  isArchived(groupId: string): Promise<boolean> {
    return this.groups.isArchived(groupId);
  }

  isSuspended(accountId: string): Promise<boolean> {
    return this.groups.isSuspended(accountId);
  }

  isDeleted(accountId: string): Promise<boolean> {
    return this.groups.isDeleted(accountId);
  }

  /**
   * The groups the asker is a member of that `other` is a current member of too, the earliest created first: Groups lists the
   * asker's groups most recent first, so they are reversed. Each group is read as the asker sees it, so a group that is not the
   * asker's is never read.
   */
  async groupsSharedBy(askedBy: string, other: string): Promise<SharedGroup[]> {
    const groups = await this.groups.listGroupsOf(askedBy);
    const shared: SharedGroup[] = [];
    for (const group of [...groups].reverse()) {
      const members = await this.groups.listMembersOf(askedBy, group.id);
      if (!members?.some(member => member.memberId === other)) continue;
      shared.push({ groupId: group.id, currency: group.currency, archived: group.archivedAt !== undefined });
    }
    return shared;
  }
}
