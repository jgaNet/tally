import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { IPassedBalances } from '@Contexts/Ledger/Application/Ports/IPassedBalances';
import { IGroupAuditQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupAuditQueries';

/**
 * Ledger's port to Groups, answered over Groups' read model (ADR 19): the balances passed to the owner when members left, read when the
 * audit is read. The read model is a function, the one Groups' wiring exports (ADR 4): it is read when the balances are asked.
 */
export class PassedBalancesFromGroups implements IPassedBalances {
  constructor(private groups: () => IGroupAuditQueries) {}

  async balancesPassedOf(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.groups().balancesPassedIn(groupId);
  }
}
