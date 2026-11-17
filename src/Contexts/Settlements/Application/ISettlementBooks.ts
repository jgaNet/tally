import { SettlementBook } from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook';

/**
 * The settlement books, as the use cases load and save them: a port Settlements owns, answered by its own store (`SqliteSettlements`).
 * The book is the aggregate every settlement of a group is decided in (ADR 11); a repository loads it and saves it, and nothing else.
 */
export interface ISettlementBooks {
  /** The book of the group as it is stored, at the version it was stored at; a new book at version 0 when none is stored yet. */
  bookOf(groupId: string): Promise<SettlementBook>;
  /**
   * The book of the group whose payment is waiting at the provider under this id, as it is stored; `undefined` when no payment waits
   * under it (a webhook about a payment Tally does not know, or one already settled, changes nothing: request 13).
   */
  bookOfPayment(providerPaymentId: string): Promise<SettlementBook | undefined>;
  /**
   * Stores the book's settlements, the outcomes of its waiting payments and its version + 1 in one transaction. Refuses a book that is
   * no longer at the stored version with a `ConcurrencyConflictException`: the caller re-reads and decides again (CONC-OPTIMISTIC).
   */
  save(book: SettlementBook): Promise<void>;
}
