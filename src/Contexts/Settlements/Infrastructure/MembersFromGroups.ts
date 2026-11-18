import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { ISettlementMembers, SharedGroup } from '@Contexts/Settlements/Application/ISettlementMembers';

/** The roster of groups, as Groups gives it to the other contexts (ADR 6): the type the wiring of Settlements is given. */
export type GroupRoster = IGroupRoster;

/**
 * The members of a group, in the order they joined, and its currency, answered over Groups' roster (ADR 9): Settlements' port
 * `ISettlementMembers` is built on the roster Groups' read model gives, so no domain imports Groups.
 */
export class MembersFromGroups implements ISettlementMembers {
  constructor(private readonly roster: GroupRoster) {}

  async membersOf(groupId: string): Promise<readonly string[] | undefined> {
    const members = await this.roster.membersOf(groupId);
    return members?.map(({ memberId }) => memberId);
  }

  async currencyOf(groupId: string): Promise<string | undefined> {
    return this.roster.currencyOf(groupId);
  }

  async ownerOf(groupId: string): Promise<string | undefined> {
    const members = await this.roster.membersOf(groupId);
    return members?.find(({ role }) => role === 'owner')?.memberId;
  }

  isArchived(groupId: string): Promise<boolean> {
    return this.roster.isArchived(groupId);
  }

  isSuspended(accountId: string): Promise<boolean> {
    return this.roster.isSuspended(accountId);
  }

  isDeleted(accountId: string): Promise<boolean> {
    return this.roster.isDeleted(accountId);
  }

  /** Every group there is, the earliest made first, that both accounts are current members of: read through the roster, one group at a time. */
  async groupsShared(accountId: string, otherId: string): Promise<SharedGroup[]> {
    const shared: SharedGroup[] = [];
    for (const groupId of await this.roster.groupIds()) {
      const members = (await this.roster.membersOf(groupId))?.map(({ memberId }) => memberId) ?? [];
      if (!members.includes(accountId) || !members.includes(otherId)) continue;
      const currency = await this.roster.currencyOf(groupId);
      if (!currency) continue;
      shared.push({ groupId, currency, archived: await this.roster.isArchived(groupId) });
    }
    return shared;
  }
}
