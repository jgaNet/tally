import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * Ledger's port to Groups, which Ledger owns (ADR 19): the balances passed to the owner when members left, read when the group's
 * audit is read. Answered by an adapter over Groups' read model.
 */
export interface IPassedBalances {
  balancesPassedOf(groupId: string): Promise<AuditEntryReadModel[]>;
}
