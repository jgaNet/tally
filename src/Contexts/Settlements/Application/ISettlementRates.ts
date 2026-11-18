/**
 * The rate a rates service offers for a currency to another on a day (request 22, request 39), in Settlements' own words: a port
 * Settlements owns, asked when a settlement in another currency is decided. `rateOf` answers the rate as the service wrote it, or
 * `undefined` when the service offers none, does not answer well or in time, or is not configured. The answer is a plain value the book
 * takes or refuses (DOMAIN-NON-DETERMINISM): with none, the settlement is refused and nothing is kept. The adapter over the service is
 * Settlements' infrastructure, so no domain imports it, and Settlements has no relationship with Ledger for it (ADR 31).
 */
export interface ISettlementRates {
  rateOf(from: string, to: string, date: string): Promise<string | undefined>;
}
