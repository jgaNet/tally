import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import {
  ISettlementMembers,
  SettlementGroup,
  SharedSettlementGroup,
} from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/**
 * Settlements' SettlementMembers, answered over Groups' read model (docs/adr/0012, docs/adr/0014, docs/adr/0032): the current members of a
 * group, in the order they joined, and its currency, for a caller who is one of them. Translated here into Settlements' words: the account
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
      ownerId: group.ownerId,
      members: members.map(({ memberId }) => ({ memberId })),
      archived: group.archivedAt !== undefined,
    };
  }

  async isSuspended(accountId: string): Promise<boolean> {
    return this.groups.isSuspended(accountId);
  }

  async isDeleted(accountId: string): Promise<boolean> {
    return this.groups.isDeleted(accountId);
  }

  async sharedGroupsOf(callerId: string, withId: string, currency: string): Promise<SharedSettlementGroup[]> {
    // `listGroupsOf` answers the most recently created first: reversed, the earliest created comes first.
    const groups = (await this.groups.listGroupsOf(callerId)).reverse();
    const shared: SharedSettlementGroup[] = [];
    for (const group of groups) {
      if (group.currency !== currency) continue;
      const members = await this.groups.listMembersOf(callerId, group.id);
      if (!members || !members.some(({ memberId }) => memberId === withId)) continue;
      shared.push({
        groupId: group.id,
        currency: group.currency,
        ownerId: group.ownerId,
        archived: group.archivedAt !== undefined,
        members: members.map(({ memberId }) => ({ memberId })),
      });
    }
    return shared;
  }
}
