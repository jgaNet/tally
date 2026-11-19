/**
 * A netting as the two people read it (request 32): who asked, with whom, the currency, the amount netted, and the settlements
 * made for it, in the order they were made.
 */
export interface NettingReadModel {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}
