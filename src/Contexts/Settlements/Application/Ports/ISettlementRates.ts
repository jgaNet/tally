import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/**
 * The rate a rates service offers, an outside system with an API of its own (request 22, ADR 15), as Settlements asks it: the
 * rate of one currency to another on a day, the UTC day a settlement is decided on (request 39). Settlements owns the port; its
 * adapter calls the service over HTTP, with a limit of 5 seconds, and answers `offered`, `none` for anything the service does not
 * answer as asked, or `unconfigured` when no service is configured. It never refuses: whether a settlement is kept at the offer is
 * the book's to decide.
 */
export interface ISettlementRates {
  /** The rate offered from `from` to `to` on `date` (YYYY-MM-DD), as the service gives it. */
  rateOn(request: { from: string; to: string; date: string }): Promise<RateOffer>;
}
