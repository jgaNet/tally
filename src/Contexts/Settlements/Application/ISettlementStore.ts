import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** What a screen shows of one settlement: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface SettlementView {
  readonly id: string;
  readonly groupId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly method: 'cash';
  readonly status: 'paid';
  readonly at: string;
}

/**
 * The store of settlements, the port the use cases write and read through (ADR 10). `versionOf` is the version a group's book is
 * at, 0 when no settlement has been recorded in it; `save` keeps a recorded settlement and stores the book at its version + 1, only
 * while the book is still at the version it was read at, and refuses it with a ConcurrencyConflictException otherwise (CONC-OPTIMISTIC);
 * `viewOf` reads a settlement as it was saved, or `undefined` when there is none.
 */
export interface ISettlementStore {
  versionOf(groupId: string): Promise<number>;
  save(book: SettlementBook, settlement: Settlement): Promise<void>;
  viewOf(settlementId: string): Promise<SettlementView | undefined>;
}
