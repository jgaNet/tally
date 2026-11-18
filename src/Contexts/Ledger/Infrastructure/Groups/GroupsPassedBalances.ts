import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { IPassedBalances } from '@Contexts/Ledger/Domain/Audit/Ports/IPassedBalances';

/**
 * Ledger's port onto Groups, answered over Groups' read model (ADR 19): the balances passed on when a member left, which
 * Groups wrote in the transaction of the leave, read as Ledger's entries.
 */
export class GroupsPassedBalances implements IPassedBalances {
  constructor(private groups: IGroupQueries) {}

  entriesOf(groupId: string): Promise<AuditEntry[]> {
    return this.groups.auditOf(groupId);
  }
}
