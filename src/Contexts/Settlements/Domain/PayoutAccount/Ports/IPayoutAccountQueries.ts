import { PayoutAccountView } from '@Contexts/Settlements/Domain/PayoutAccount/DTOs';

/** The read side of the payout accounts: what a person's account is, as `GetPayoutAccount` answers it (request 16). */
export interface IPayoutAccountQueries {
  /** The provider's id of the person's payout account; `undefined` when the person has none. */
  findPayoutAccount(accountId: string): Promise<PayoutAccountView | undefined>;
}
