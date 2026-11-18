import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/**
 * The rate a rates service offers, an outside system with an API of its own (request 22, ADR 15), as Ledger asks it: the
 * rate of one currency to another on a day. Ledger owns the port; its adapter calls the service over HTTP, with a limit of
 * 5 seconds, and answers `offered`, `none` for anything the service does not answer as asked, or `unconfigured` when no
 * service is configured. It never refuses: whether the offer is taken is the expense's to decide.
 */
export interface IOfferedRates {
  /** The rate offered from `from` to `to` on `date` (YYYY-MM-DD), as the service gives it. */
  rateOn(request: { from: string; to: string; date: string }): Promise<RateOffer>;
}
