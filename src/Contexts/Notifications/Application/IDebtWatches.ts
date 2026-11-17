import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * The store of the debt watches, which the sweep reads and writes (request 18, ADR 15). A save is conditional on the version the watch
 * was read at (CONC-OPTIMISTIC): of two servers that read the same one, the second is refused and re-reads.
 */
export interface IDebtWatches {
  /** Every watch, in no order. */
  all(): Promise<DebtWatch[]>;
  /**
   * Stores the watch at version + 1, and the reminder it made, if it made one, in the same transaction: a reminder is made once
   * with the watch that says it was made. Refuses with a `ConcurrencyConflictException` a watch that is no longer at the stored version.
   */
  save(watch: DebtWatch, reminder?: Notice): Promise<void>;
}
