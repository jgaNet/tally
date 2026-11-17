import { IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** The store of the settlement books: loads and saves a group's book inside a transaction only (docs/adr/0013). */
export interface ISettlementBooks {
  /** The group's book as it is stored, at the version it is at; a book with no settlement yet is at version 0. */
  get(groupId: string): Promise<SettlementBook>;
  /**
   * Stores the settlements recorded in the book, if the book is still at the version it was read at: a conflict otherwise
   * (ConcurrencyConflictException, CONC-OPTIMISTIC, docs/adr/0013). The store then holds one version more.
   */
  save(book: SettlementBook): Promise<IResult<undefined>>;
}
