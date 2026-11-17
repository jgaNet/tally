import { Id, IResult } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

export interface ISettlementBookRepository {
  /** The book of the group as it was read (its version; 0 when none was ever stored). Never null. */
  findByGroup(groupId: Id): Promise<SettlementBook>;
  /** Stores the settlements the book decided, and the book at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(book: SettlementBook): Promise<IResult>;
}
