import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** The day and the two currencies a rate is asked for: what one `from` is worth in `to` on `date` (a `YYYY-MM-DD` day). */
export interface OfferedRateRequest {
  from: string;
  to: string;
  date: string;
}

/**
 * Ledger's port to the rates service, which Ledger owns (ADR 13; the storm's OfferedRates): the rate a rates service offers for a
 * currency to another on a day. Its answer is a plain value the expense takes or refuses (DOMAIN-NON-DETERMINISM): a rate, no rate,
 * or no service at all. An adapter answers it over the service's API, within a limit.
 */
export interface IOfferedRates {
  rateOn(request: OfferedRateRequest): Promise<RateOffer>;
}
