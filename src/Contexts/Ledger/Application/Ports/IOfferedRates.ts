import { OfferedRate } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';

/**
 * The rates a rates service offers, as Ledger needs them (request 22, docs/adr/0021): the rate of one currency to another on a day, or
 * the answer that there is none. Ledger owns the port, in its own words; an adapter in its Infrastructure calls the rates service's
 * API. The answer is a plain value the Expense takes or refuses: the rate is asked, not decided here, and it is never kept by Ledger
 * except as the rate of the expense it is recorded at (DOMAIN-NON-DETERMINISM).
 */
export interface IOfferedRates {
  /**
   * The rate offered for `from` to `to` on `date` (a day, `YYYY-MM-DD`): `offered` with the rate, `none` when the service has no rate or
   * does not answer one in time, and `unavailable` when no rates service is configured. It never throws.
   */
  offeredRate(request: { from: string; to: string; date: string }): Promise<OfferedRate>;
}
