import { CURRENCIES, CurrencyCode } from '@SharedKernel/Domain/Currency';

import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { OfferedRate, OriginalPaymentInput } from '@Contexts/Settlements/Domain/Settlement/OriginalPayment';

/**
 * The rate offered for what a settlement is paid in, on the day it is decided, in UTC (request 39, docs/adr/0038). The rates service is asked
 * only for a currency of Tally other than the group's: a settlement in the group's own currency asks nothing, and an unknown currency is
 * refused by the book before any rate matters. Answers `undefined` when nothing is asked; the book then has no rate, and refuses it.
 */
export async function offeredRateOf({
  rates,
  original,
  groupCurrency,
  at,
}: {
  rates: ISettlementRates;
  original: OriginalPaymentInput | undefined;
  groupCurrency: string;
  at: Date;
}): Promise<OfferedRate | undefined> {
  if (original === undefined) return undefined;
  if (!CURRENCIES.includes(original.currency as CurrencyCode) || original.currency === groupCurrency) return undefined;
  return rates.offeredRate({ from: original.currency, to: groupCurrency, date: at.toISOString().slice(0, 10) });
}
