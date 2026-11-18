import { OfferedRate } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/**
 * The rate a rates service offers for a currency to another on a day (request 22, the storm's OfferedRates), in Ledger's own words: a
 * port Ledger owns, read when an expense in another currency is decided, and by the rate query. `rateOf` answers the rate offered,
 * no rate, or no rates service at all; the answer is a plain value the expense takes or refuses (DOMAIN-NON-DETERMINISM). The adapter
 * over the service is Ledger's infrastructure, so no domain imports it.
 */
export interface IOfferedRates {
  rateOf(from: string, to: string, date: string): Promise<OfferedRate>;
}
