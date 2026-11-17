import { Id, IResult } from '@Architecture/Domain';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

export interface IPayoutAccountRepository {
  /** The payout account of this person as it was read (its version), or null when the person has none. */
  findByOwner(owner: Id): Promise<PayoutAccount | null>;
  /** Stores the payout account at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(account: PayoutAccount): Promise<IResult>;
}
