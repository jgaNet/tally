/** A payout account as the store keeps it: the aggregate's identity, the member it is for, the provider's id of the account (null until set), and the version it was read at. */
export interface IPayoutAccountSnapshot {
  _id: string;
  owner: string;
  accountId: string | null;
  version: number;
}
