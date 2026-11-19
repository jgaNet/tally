import { OfferedRate } from '@Contexts/Settlements/Domain/Settlement/OriginalPayment';

/**
 * The rates a rates service offers, as Settlements needs them (request 39, docs/adr/0030, docs/adr/0038): the rate of one currency to
 * another on a day, or the answer that there is none. Settlements owns the port, in its own words; an adapter in its Infrastructure calls the
 * rates service's API, over the same outside service as Ledger's offered rates, with no relationship between the two contexts. The answer is a
 * plain value the book takes or refuses: the rate is asked, not decided here (DOMAIN-NON-DETERMINISM).
 */
export interface ISettlementRates {
  /**
   * The rate offered for `from` to `to` on `date` (a day, `YYYY-MM-DD`, in UTC): `offered` with the rate, or `none` when the service has no
   * rate, does not answer one in time, or is not configured. It never throws.
   */
  offeredRate(request: { from: string; to: string; date: string }): Promise<OfferedRate>;
}
