import { Id, IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

export interface ISettlementBookRepository {
  /** The book of the group, or null when no settlement has been recorded in it yet. */
  findByGroupId(groupId: Id): Promise<SettlementBook | null>;
  /**
   * Stores a group's first settlement (opening its book at version 1), or the book at its version + 1 with the settlements it
   * recorded. It runs in the command's transaction. A book no longer at the version it was read at, or a book another writer
   * opened first, is a ConcurrencyConflict, and the command reads and decides again.
   */
  save(book: SettlementBook): Promise<IResult>;
}
