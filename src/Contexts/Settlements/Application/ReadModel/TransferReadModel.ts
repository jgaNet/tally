/** One suggested transfer as a member reads it: `from` pays `to` the `amount`, both members' account ids. */
export interface TransferReadModel {
  from: string;
  to: string;
  amount: number;
}
