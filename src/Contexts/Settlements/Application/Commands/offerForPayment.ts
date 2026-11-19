import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { OriginalAmount, RateOffer } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/**
 * The rate offered for a payment in another currency, on the UTC day it is decided (request 39): asked of the rates service
 * only when the currency may be paid in at all, so that a currency Tally does not have, or the group's own, is refused by the
 * book before anything is asked. Its answer is the book's to take or refuse.
 */
export async function offerForPayment(
  { currency, groupCurrency, at }: { currency: string; groupCurrency: string; at: Date },
  rates: ISettlementRates,
): Promise<RateOffer> {
  if (OriginalAmount.checkCurrency(currency, groupCurrency).isFailure()) return { kind: 'none' };
  return rates.rateOn({ from: currency, to: groupCurrency, date: at.toISOString().slice(0, 10) });
}
