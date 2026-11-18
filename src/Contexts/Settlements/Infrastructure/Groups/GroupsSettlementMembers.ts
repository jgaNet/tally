import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { ISettlementMembers, SettlementMember } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';

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

  async currencyOf(groupId: string, askedBy: string): Promise<string | null> {
    const group = await this.groups.findGroupOf(askedBy, groupId);
    return group ? group.currency : null;
  }

  isArchived(groupId: string): Promise<boolean> {
    return this.groups.isArchived(groupId);
  }
}
