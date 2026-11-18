/**
 * A netting as the queries answer it (request 32): who asked, with whom, its currency, the amount netted, and its settlements' ids, in
 * the order they were made.
 */
export interface NettingView {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}
