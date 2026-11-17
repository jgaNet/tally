import { IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The settlement books, as aggregates: one per group. It loads and saves them, and answers the facts a decision needs
 * about the collection: the book of a group, if it has one, and the book holding a payment the provider reports by its
 * id. A save is refused with a ConcurrencyConflictException when the book is no longer at the version it was read at
 * (CONC-OPTIMISTIC).
 */
export interface ISettlementBookRepository {
  /** The book of the group, or null when no settlement was ever decided in it. */
  findByGroupId(groupId: string): Promise<SettlementBook | null>;
  /** The book holding the settlement paid through the provider under this provider's payment id, or null when none holds it. */
  findByPaymentId(paymentId: string): Promise<SettlementBook | null>;
  save(book: SettlementBook): Promise<IResult>;
}
