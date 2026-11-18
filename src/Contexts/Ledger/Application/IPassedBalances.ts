import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The entries of the balances that passed to the owner when members left a group, as Ledger's audit reads them (feature 28, ADR 23): a
 * port Ledger owns, in its own words, answered over Groups' read model. Each entry is a balance passed, as Groups wrote it when the member
 * left. The adapter is Ledger's infrastructure over Groups' roster, so no domain imports Groups.
 */
export interface IPassedBalances {
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
