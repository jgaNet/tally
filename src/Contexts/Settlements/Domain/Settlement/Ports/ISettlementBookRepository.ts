import { Id, IResult } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

export interface ISettlementBookRepository {
  /** The book of the group as it was read: its version (0 when none was ever stored) and its settlements. Never null. */
  findByGroup(groupId: Id): Promise<SettlementBook>;
  /** The book of the group that holds this payment at the provider, or null when no settlement holds it. */
  findByPaymentId(paymentId: string): Promise<SettlementBook | null>;
  /** The book of the group that holds this settlement, or null when no settlement has this id. */
  findBySettlement(settlementId: Id): Promise<SettlementBook | null>;
  /** Stores the settlements the book decided or changed, and the book at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(book: SettlementBook): Promise<IResult>;
}
