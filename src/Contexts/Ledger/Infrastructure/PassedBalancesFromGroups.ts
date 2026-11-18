import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { IPassedBalances } from '@Contexts/Ledger/Application/IPassedBalances';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/** Groups' roster, as Groups gives it to the other contexts (ADR 6): the type the wiring of Ledger is given. */
export type PassedBalancesRoster = IGroupRoster;

/**
 * The balances that passed to the owner when members left a group, as audit entries, answered over Groups' roster (feature 28, ADR 23):
 * Ledger's port `IPassedBalances` is built on the roster Groups gives, and no domain imports Groups.
 */
export class PassedBalancesFromGroups implements IPassedBalances {
  constructor(private readonly roster: PassedBalancesRoster) {}

  async entriesOf(groupId: string): Promise<AuditEntry[]> {
    return this.roster.auditOf(groupId);
  }
}
