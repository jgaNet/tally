import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';

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
}
