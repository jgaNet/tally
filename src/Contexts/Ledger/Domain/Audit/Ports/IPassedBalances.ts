import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * Ledger's own port onto Groups: the balances passed on when a member left, as audit entries (request 28, ADR 19, and the
 * passing of request 20). The adapter answers over Groups' read model; no domain imports Groups.
 */
export interface IPassedBalances {
  /** The entries of the balances passed on in the group, in the order they were passed. */
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
