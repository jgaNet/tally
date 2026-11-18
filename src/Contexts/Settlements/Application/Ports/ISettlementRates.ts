import { CURRENCIES, OriginalRequest } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/RateOffer';

/** What Settlements asks a rate for: one currency in another, on a day (`YYYY-MM-DD`, in UTC). */
export interface RateQuery {
  from: string;
  to: string;
  date: string;
}

/**
 * Settlements' own port onto the rates service, an outside system with an API of its own (request 22), as Ledger has its own
 * (ADR 13): the rate offered from one currency to another on a day, as a plain value the SettlementBook takes or refuses
 * (DOMAIN-NON-DETERMINISM). The adapter answers over the service's HTTP API; nothing here names it.
 */
export interface ISettlementRates {
  rateOf(query: RateQuery): Promise<RateOffer>;
}

/**
 * The rate offered for what a settlement pays in another currency, asked by the handler before the book decides (request 39): on the
 * day the settlement is decided, in UTC. Asked only for a currency that is one of Tally's and not the group's; anything else is
 * refused by the book itself, and the service is not asked about it.
 */
export async function offerForSettlement(
  rates: ISettlementRates,
  original: OriginalRequest,
  groupCurrency: string,
  at: Date,
): Promise<RateOffer> {
  if (!CURRENCIES.includes(original.currency) || original.currency === groupCurrency) return { kind: 'none' };
  return rates.rateOf({ from: original.currency, to: groupCurrency, date: at.toISOString().slice(0, 10) });
}
