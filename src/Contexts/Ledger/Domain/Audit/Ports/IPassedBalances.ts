import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';

/**
 * The balances that passed to the owner when a member left, read by a group's audit (request 28, docs/adr/0027; docs/adr/0019).
 * Ledger owns the port, in its own words; Groups answers it through an adapter in Ledger's Infrastructure, over Groups' read model.
 */
export interface IPassedBalances {
  /** The balance-passed entries of the group, the oldest first. */
  entriesOf(groupId: string): Promise<AuditEntryView[]>;
}
