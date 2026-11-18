import { RateOffer } from '@Contexts/Ledger/Domain/Expense/Rate';

/** What `GetOfferedRate` answers (request 22): the currency, the day, and the rate as the rates service gives it. */
export interface OfferedRateView {
  currency: string;
  date: string;
  rate: string;
}

/**
 * The rate a rates service offers for a currency to another on a day (request 22, ADR 19): a port Ledger owns, in its own words, answered
 * by an adapter over the rates service at `RATES_URL` (`OfferedRatesOverHttp`, in the wiring of this context). Its answer is a plain value
 * the expense takes or refuses (`RateOffer`, DOMAIN-NON-DETERMINISM): a rate, none, or no rates service at all. It is asked before a
 * decision, never inside it.
 */
export interface IOfferedRates {
  /** The rate `from` is worth in `to` on the day `date` (a day written YYYY-MM-DD), as the service gives it, or what the answer is when it gives none. */
  rateFor(query: { from: string; to: string; date: string }): Promise<RateOffer>;
}
