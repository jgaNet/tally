/** The day and the two currencies a rate is asked for: what one `from` is worth in `to` on `date` (a `YYYY-MM-DD` day, in UTC). */
export interface SettlementRateRequest {
  from: string;
  to: string;
  date: string;
}

/**
 * Settlements' port to the rates service (the storm's OfferedRates for Settlements, ADR 30): the rate a rates service offers for a
 * currency to another on a day, or none. Its answer is a plain value the book takes or refuses (DOMAIN-NON-DETERMINISM): a rate as the
 * service wrote it, or `null` for no rate, for any answer that is not one, and for no service at all. An adapter answers it over the
 * service's API, within a limit; Ledger has its own port to the same service, and the two do not know of each other.
 */
export interface ISettlementRates {
  rateOn(request: SettlementRateRequest): Promise<string | null>;
}
