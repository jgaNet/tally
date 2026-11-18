import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { ISettlementMembers, SettlementGroup } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/**
 * Settlements' SettlementMembers, answered over Groups' read model (docs/adr/0012, docs/adr/0014): the current members of a group, in
 * the order they joined, and its currency, for a caller who is one of them. Translated here into Settlements' words: the account
 * ids and the currency, nothing else of a member or of a group.
 */
export class SettlementMembersOfGroups implements ISettlementMembers {
  constructor(private readonly groups: IGroupQueries) {}

  async groupOf(callerId: string, groupId: string): Promise<SettlementGroup | undefined> {
    const group = await this.groups.findGroupOf(callerId, groupId);
    if (!group) return undefined;
    const members = await this.groups.listMembersOf(callerId, groupId);
    if (!members) return undefined;
    return {
      currency: group.currency,
      members: members.map(({ memberId }) => ({ memberId })),
      archived: group.archivedAt !== undefined,
    };
  }
}
