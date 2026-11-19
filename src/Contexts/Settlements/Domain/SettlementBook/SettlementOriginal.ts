import { IResult, Result } from '@Architecture/Domain';
import { convertAtRate, isCurrencyCode, isRate } from '@SharedKernel/Domain';

import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
} from './SettlementExceptions';

/** The most a settlement's original amount may be, in its currency's hundredths (request 39). */
export const MAX_ORIGINAL_AMOUNT = 100_000_000;

/**
 * What a settlement paid in another currency is kept as (request 39): the currency, its amount in that currency's hundredths, and the rate
 * at which one of that currency is worth the group's, as the rates service wrote it when the settlement was decided. Kept as it was decided,
 * whatever the service says later.
 */
export interface OriginalPayment {
  currency: string;
  amount: number;
  rate: string;
}

/** What the payer states for a settlement paid in another currency: the currency and the amount paid in it. The rate is not theirs to give. */
export interface OriginalGiven {
  currency: string;
  amount: number;
}

/**
 * Whether a settlement's original payment needs the rate offered for it: one of Tally's currencies other than the group's (request 39). Pure:
 * the use case asks the rates service only then, so a currency that is not Tally's, or the group's own, is refused without a question.
 */
export function needsOfferedRate(original: OriginalGiven | undefined, groupCurrency: string): boolean {
  return original !== undefined && isCurrencyCode(original.currency) && original.currency !== groupCurrency;
}

/**
 * The original payment of a settlement, checked and converted (request 39, ADR 37): its currency is one of Tally's other than the group's, its
 * amount a whole number from 1 to 100 000 000, and the rate the rates service offered for it, the one the settlement keeps, when one is offered.
 * Answers the settlement's original payment and its amount in the group's currency, the original amount times the rate, rounded half up, as an
 * expense's is. No rate offered refuses the settlement by its name; the rate is never the payer's to give.
 */
export function originalPaymentOf({
  original,
  groupCurrency,
  offeredRate,
}: {
  original: OriginalGiven;
  groupCurrency: string;
  offeredRate: string | undefined;
}): IResult<{ amount: number; original: OriginalPayment }> {
  if (!isCurrencyCode(original.currency)) return Result.fail(new InvalidOriginalCurrencyException());
  if (original.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
  if (!Number.isInteger(original.amount) || original.amount < 1 || original.amount > MAX_ORIGINAL_AMOUNT) {
    return Result.fail(new InvalidOriginalAmountException());
  }
  if (offeredRate === undefined || !isRate(offeredRate)) return Result.fail(new NoRateOfferedException());
  return Result.ok({
    amount: convertAtRate(original.amount, offeredRate),
    original: { currency: original.currency, amount: original.amount, rate: offeredRate },
  });
}
