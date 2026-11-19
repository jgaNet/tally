import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/**
 * The nettings, as `NetDebts` saves them: a port Settlements owns, answered by its own store (`SqliteNettings`). A netting is written once,
 * in the transaction of the settlements it made, and is read back by `GetNetting` through the read side (`ISettlementQueries.nettingOf`).
 */
export interface INettings {
  /** Stores the netting and its settlements, in the transaction the caller runs (ADR 17). */
  save(netting: Netting): Promise<void>;
}
