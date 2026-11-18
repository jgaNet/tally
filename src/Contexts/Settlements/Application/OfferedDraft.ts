import { ISettlementRates } from '@Contexts/Settlements/Application/ISettlementRates';
import { Currency } from '@SharedKernel/Domain';

import { OriginalDraft } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/** What a request gives for a settlement in another currency: the currency and the amount in its hundredths, never a rate (request 39). */
export interface OriginalRequest {
  readonly currency: string;
  readonly amount: number;
}

/**
 * The draft of a settlement paid in another currency, with the rate the rates service offers for it on the day it is decided, in UTC
 * (request 39). The rates service is asked only for a currency Tally knows that is not the group's: any other is refused by the book by its
 * name, without an answer from the service. A settlement in the group's currency has no draft: it is given its amount. Nothing is kept here.
 */
export const originalDraftOf = async (
  rates: ISettlementRates,
  groupCurrency: string,
  original: OriginalRequest | undefined,
  now: Date,
): Promise<OriginalDraft | undefined> => {
  if (!original) return undefined;
  const askable = Currency.isCode(original.currency) && original.currency !== groupCurrency;
  const offered = askable
    ? await rates.rateOf(original.currency, groupCurrency, now.toISOString().slice(0, 10))
    : undefined;
  return { currency: original.currency, amount: original.amount, offered };
};
