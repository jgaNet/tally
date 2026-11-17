import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';

/**
 * Settlements' port to Groups, answered over Groups' read model (ADR 6): the ids and the currency the read model gives, as they are.
 * The read model is the one Groups' wiring exports, and it is a function for the reason Ledger's adapter gives (ADR 3, ADR 4).
 */
export class SettlementMembersFromGroups implements ISettlementMembers {
  constructor(private groups: () => IGroupMembersQueries) {}

  async membersOf(groupId: string): Promise<string[]> {
    return this.groups().memberIdsOf(groupId);
  }

  async isMemberOf(groupId: string, accountId: string): Promise<boolean> {
    return this.groups().isMemberOf(groupId, accountId);
  }

  async currencyOf(groupId: string): Promise<string | null> {
    return this.groups().currencyOf(groupId);
  }
}
