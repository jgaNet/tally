import { MAX_AMOUNT, isOtherCurrency, todayInUtc } from '../expenses/validation';
import { type Currency, minorUnitDigitsOf } from '../groups/validation';
import { convertedAmount, millionthsOf, offeredRate, type RatesConfig } from '../rates/rates';
import { Refusal } from '../refusal';

/** The rate of a settlement in the group's own currency, in millionths: one of it is worth one of it. */
const SAME_CURRENCY = 1_000_000n;

/** The amount of a settlement as a request gives it: in the group's currency, or in another currency. */
export type SettlementMoneyInput =
  { kind: 'group'; amount: number } | { kind: 'other'; currency: string; amount: number };

/** A settlement paid in another currency: what was paid in it, and the rate it was decided at. */
export interface SettlementOriginal {
  currency: Currency;
  /** In the minor unit of `currency`. */
  amount: number;
  /** The rate as the rates service wrote it: what one of `currency` is worth in the group's currency. */
  rate: string;
}

/** A settlement's amount, decided: in the group's currency, with its original and rate when it has one. */
export interface PricedSettlement {
  /** In the minor unit of the group's currency: the original times the rate, to the nearest whole number. */
  amount: number;
  original?: SettlementOriginal;
  /** The rate in millionths, which converts the provider's fee the same way. `SAME_CURRENCY` for the group's own. */
  millionths: bigint;
}

/**
 * Decides the amount of a settlement of a `groupCurrency` group. An amount in the group's currency is taken as it is,
 * the rules of the settlement checking it. An amount in another currency must be one of Tally's currencies other than
 * the group's, in a whole number of its minor unit from 1 to `MAX_AMOUNT`, and is converted at the rate the rates service
 * offers for that currency on today (UTC), which the payer does not give. Refused with `409 NoRateOffered` when there
 * is no rate to take, with `422` for a currency or an amount that is not allowed, and with `422 InvalidAmount` when the
 * converted amount is not in the group's currency's range. Asks the rates service and writes nothing.
 */
export async function priceSettlement(
  rates: RatesConfig,
  groupCurrency: Currency,
  money: SettlementMoneyInput,
): Promise<PricedSettlement> {
  if (money.kind === 'group') {
    return { amount: money.amount, millionths: SAME_CURRENCY };
  }
  if (!isOtherCurrency(money.currency, groupCurrency)) {
    throw new Refusal(
      422,
      'InvalidOriginalCurrency',
      'The currency of a settlement in another currency must be one of Tally’s currencies other than the group’s.',
    );
  }
  if (!Number.isInteger(money.amount) || money.amount < 1 || money.amount > MAX_AMOUNT) {
    throw new Refusal(
      422,
      'InvalidOriginalAmount',
      `The amount in that currency must be a whole number from 1 to ${MAX_AMOUNT}.`,
    );
  }

  const currency = money.currency as Currency;
  const offered = await offeredRate(rates, currency, groupCurrency, todayInUtc());
  const millionths = offered === undefined ? undefined : millionthsOf(offered);
  if (offered === undefined || millionths === undefined) {
    throw new Refusal(
      409,
      'NoRateOffered',
      'No rate is offered for that currency today, so the settlement cannot be decided at a rate.',
    );
  }

  const converted = convertedAmount(
    money.amount,
    millionths,
    minorUnitDigitsOf(currency),
    minorUnitDigitsOf(groupCurrency),
  );
  if (converted < 1n || converted > BigInt(MAX_AMOUNT)) {
    throw new Refusal(
      422,
      'InvalidAmount',
      `The amount in the group’s currency must be a whole number from 1 to ${MAX_AMOUNT}.`,
    );
  }
  return {
    amount: Number(converted),
    original: { currency, amount: money.amount, rate: offered },
    millionths,
  };
}

/** The settlement's amount in the currency it is paid in: the original when it has one, else the group's amount. */
export function paidOf(priced: PricedSettlement, groupCurrency: Currency): { currency: Currency; amount: number } {
  return priced.original === undefined
    ? { currency: groupCurrency, amount: priced.amount }
    : { currency: priced.original.currency, amount: priced.original.amount };
}
