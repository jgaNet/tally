import { Id, IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

export interface ISettlementBookRepository {
  /** The book of the group, with the payments waiting in it, or null when no settlement has been recorded in it yet. */
  findByGroupId(groupId: Id): Promise<SettlementBook | null>;
  /** The book of the group that holds the payment the provider knows under this id, or null when Tally knows no such payment. */
  findByProviderPaymentId(paymentId: string): Promise<SettlementBook | null>;
  /**
   * Stores a group's first settlement (opening its book at version 1), or the book at its version + 1 with the settlements it
   * recorded and the payments whose status changed. It runs in the command's transaction. A book no longer at the version it was
   * read at, or a book another writer opened first, is a ConcurrencyConflict, and the command reads and decides again.
   */
  save(book: SettlementBook): Promise<IResult>;
}
