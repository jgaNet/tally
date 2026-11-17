import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * The store of payout accounts, the port the payout-account use cases and the payments read and write through (request 16, ADR 11).
 * `payoutAccountOf` reads a person's account, or `undefined` when they have none; `save` keeps an account as it was decided, at its
 * version + 1, only while it is still at the version it was read at, and refuses it with a ConcurrencyConflictException otherwise
 * (CONC-OPTIMISTIC).
 */
export interface IPayoutAccountStore {
  payoutAccountOf(ownerId: string): Promise<PayoutAccount | undefined>;
  save(account: PayoutAccount): Promise<void>;
}
