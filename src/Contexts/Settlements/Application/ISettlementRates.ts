/**
 * The rates a rates service offers, as Settlements needs them to take a settlement paid in another currency (request 39): a port Settlements
 * owns, in its own words (ADR 37), answered by an adapter over the rates service (`SettlementRatesOverHttp`, in this context's Infrastructure).
 * The rates service is an outside system, so no context of Tally is related to it through this port. The answer is a plain value: the rate
 * as the service writes it, or `undefined` when it offers none, or did not answer as it should, or not in time. The decision refuses the
 * settlement when none is offered (DOMAIN-NON-DETERMINISM). It is asked before a decision, never inside it.
 */
export interface ISettlementRates {
  /** The rate `from` is worth in `to` on the day `date` (a day written YYYY-MM-DD), as the service gives it, or `undefined` when none is offered. */
  rateFor(query: { from: string; to: string; date: string }): Promise<string | undefined>;
}
