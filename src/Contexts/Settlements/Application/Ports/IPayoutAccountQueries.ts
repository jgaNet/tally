import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';

/** What the screens read of a payout account, from the SQLite file, outside any transaction. */
export interface IPayoutAccountQueries {
  /** The payout account of this person, or null when the person has set none. */
  findByOwner(owner: string): Promise<PayoutAccountReadModel | null>;
}
