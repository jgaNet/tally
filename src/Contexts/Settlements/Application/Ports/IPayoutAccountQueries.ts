import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';

/** Settlements' read side of payout accounts: the account a person is paid on, or null when they have set none. */
export interface IPayoutAccountQueries {
  findByOwner(ownerId: string): Promise<PayoutAccountReadModel | null>;
}
