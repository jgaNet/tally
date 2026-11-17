import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { ISettlementMembers, SettlementMember } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/**
 * Settlements' SettlementMembers, answered over Groups' read model (docs/adr/0012): the current members of a group, in the order
 * they joined, for a caller who is one of them. Translated here into Settlements' words: the account id, nothing else of a member.
 */
export class SettlementMembersOfGroups implements ISettlementMembers {
  constructor(private readonly groups: IGroupQueries) {}

  async membersOf(callerId: string, groupId: string): Promise<SettlementMember[] | undefined> {
    const members = await this.groups.listMembersOf(callerId, groupId);
    return members?.map(({ memberId }) => ({ memberId }));
  }
}
