import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * Ledger's PassedBalances (request 28): the balances a member who left passed to the owner, as Groups recorded them, for the
 * group's audit. Ledger owns the port; its adapter answers it over Groups' read side. A balance of 0 is not an entry.
 */
export interface IPassedBalances {
  entriesOf(groupId: string): Promise<AuditEntryReadModel[]>;
}
