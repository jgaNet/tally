import { IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The settlement books, as aggregates: one per group. It loads and saves them, and answers the one fact a decision needs
 * about the collection: the book of a group, if it has one. A save is refused with a ConcurrencyConflictException when
 * the book is no longer at the version it was read at (CONC-OPTIMISTIC).
 */
export interface ISettlementBookRepository {
  /** The book of the group, or null when no settlement was ever decided in it. */
  findByGroupId(groupId: string): Promise<SettlementBook | null>;
  save(book: SettlementBook): Promise<IResult>;
}
