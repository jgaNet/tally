import { IResult } from '@Architecture/Domain';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** The store of the settlement books: loads and saves a group's book inside a transaction only (docs/adr/0013, docs/adr/0014). */
export interface ISettlementBooks {
  /** The group's book as it is stored, at the version it is at, with its pending settlements; a book with no settlement yet is at version 0. */
  get(groupId: string): Promise<SettlementBook>;
  /**
   * The book of the group whose pending settlement the provider's payment id names, as it is stored; `undefined` when no pending
   * settlement has that payment (a webhook about a payment Tally does not know changes nothing).
   */
  ofPayment(providerPaymentId: string): Promise<SettlementBook | undefined>;
  /**
   * The book of the group the settlement belongs to, as it is stored, whatever the settlement is; `undefined` when there is no such
   * settlement. Read inside the transaction, where the settlement's own query cannot be used (request 15).
   */
  ofSettlement(settlementId: string): Promise<SettlementBook | undefined>;
  /**
   * Stores what the book recorded and what the provider ended, if the book is still at the version it was read at: a conflict
   * otherwise (ConcurrencyConflictException, CONC-OPTIMISTIC, docs/adr/0013). The store then holds one version more.
   */
  save(book: SettlementBook): Promise<IResult<undefined>>;
}
