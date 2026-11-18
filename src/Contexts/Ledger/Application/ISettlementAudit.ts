import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The audit entries of the settlements a group counts (request 28), as Ledger reads them: a port Ledger owns, in its own words (CTX-CONTRACTS,
 * ADR 25), answered by an adapter over Settlements' read model (`SettlementAuditOfSettlements`, in the wiring of this context). Settlements
 * keeps them: a settlement paid, and one refunded once it had been paid. Ledger's Domain never imports Settlements.
 */
export interface ISettlementAudit {
  /** The settlement entries of the group, in no order: `GetGroupAudit` orders them with the others by when they were made. */
  auditOf(groupId: string): Promise<AuditEntry[]>;
}
