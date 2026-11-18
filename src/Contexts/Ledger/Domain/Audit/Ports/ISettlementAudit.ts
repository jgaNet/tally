import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';

/**
 * The settlements' changes of money, read by a group's audit (request 28, docs/adr/0027). Ledger owns the port, in its own words;
 * Settlements answers it through an adapter in Ledger's Infrastructure, over Settlements' read model.
 */
export interface ISettlementAudit {
  /** The settlements' entries of the group, the oldest first. */
  entriesOf(groupId: string): Promise<AuditEntryView[]>;
}
