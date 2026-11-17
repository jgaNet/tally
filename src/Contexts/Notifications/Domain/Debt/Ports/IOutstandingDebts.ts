import { OutstandingDebt } from '@Contexts/Notifications/Domain/Debt/DTOs';

/**
 * What every member of every group still owes, as Settlements answers it (request 18, docs/adr/0018, the Settlements → Notifications
 * link of conventions/domain.yaml). Notifications owns the port, in its own words; an adapter in its Infrastructure answers it over
 * Settlements' read model. Read by the sweep, never by a request: a read answers what is kept, and nothing is noted by reading.
 */
export interface IOutstandingDebts {
  outstandingDebts(): Promise<OutstandingDebt[]>;
}
