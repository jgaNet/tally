import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';
import { IPassedBalances } from '@Contexts/Ledger/Domain/Audit/Ports/IPassedBalances';

/**
 * Ledger's PassedBalances, answered over Groups' read model (request 28, docs/adr/0027): each balance a leave passed to the owner, as a
 * balance-passed entry of the group's audit. The member who left is both the one who acted and the subject.
 */
export class PassedBalancesOfGroups implements IPassedBalances {
  constructor(private readonly groups: IGroupQueries) {}

  async entriesOf(groupId: string): Promise<AuditEntryView[]> {
    const leaves = await this.groups.passedLeavesOf(groupId);
    return leaves.map(({ id, at, memberId, amount }) => ({
      id,
      at,
      by: memberId,
      action: 'balance-passed',
      subjectId: memberId,
      amount,
    }));
  }
}
