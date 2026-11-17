import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';

/**
 * Settlements' SettlementMembers, answered over Groups' read side (ADR 3, ADR 5): the current members Groups lists, in the
 * order they joined. Settlements never reaches into Groups' application or infrastructure.
 */
export class GroupsSettlementMembers implements ISettlementMembers {
  constructor(private readonly groups: IGroupMembership) {}

  currentMembers(groupId: string): Promise<string[]> {
    return this.groups.listMemberIds(groupId);
  }
}
