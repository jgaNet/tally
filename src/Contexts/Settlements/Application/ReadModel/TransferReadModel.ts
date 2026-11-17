/** One suggested transfer of a group, in the order it is made: `from` pays `to` the `amount`, both account ids. */
export interface TransferReadModel {
  from: string;
  to: string;
  amount: number;
}
