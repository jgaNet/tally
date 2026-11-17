import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

/**
 * The debt watches this context keeps, read and written by the sweep alone: Notifications' own port, over its own table. `all` reads
 * every watch as it is committed; `save` stores a watch that changed, over the version it was read at, or refuses it with a
 * ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export interface IDebtWatchStore {
  all(): Promise<DebtWatch[]>;
  save(watch: DebtWatch): Promise<void>;
}
