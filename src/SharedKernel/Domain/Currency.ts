/**
 * The currencies Tally counts in (requests 2 and 40): a group is in one of them, and an expense or a settlement may be paid in another
 * of them. The list, and the number of decimals of each one's minor unit, are the published facts about money every context agrees on,
 * so they live in the shared kernel, not in one context. An amount of Tally is a whole number of its currency's minor unit: 1250 is
 * 12.50 in EUR, 1250 in JPY, and 1.250 in KWD.
 */
export const MINOR_UNIT_DECIMALS = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
} as const;

export const CURRENCIES = Object.keys(MINOR_UNIT_DECIMALS) as (keyof typeof MINOR_UNIT_DECIMALS)[];
export type CurrencyCode = keyof typeof MINOR_UNIT_DECIMALS;

export const isCurrencyCode = (raw: string): raw is CurrencyCode =>
  Object.prototype.hasOwnProperty.call(MINOR_UNIT_DECIMALS, raw);

/** How many minor units make one unit of the currency: 1 for JPY, 100 for EUR, 1000 for KWD. */
export const minorUnitsPerUnit = (code: CurrencyCode): number => 10 ** MINOR_UNIT_DECIMALS[code];

/** The rate keeps 6 digits after the point (request 22). */
const RATE_DIGITS = 6;

/** The rate times 10^6, as an integer: `"12.5"` is 12 500 000. Only a rate of the form `^\d+(\.\d{1,6})?$` is read this way. */
export const scaleRate = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(RATE_DIGITS, '0'));
};

/**
 * An amount of the minor unit of `from`, in the minor unit of `to`, at a rate that says what one unit of `from` is worth in `to`: the
 * amount read in its currency's units, times the rate, written in the other's minor unit, to the nearest whole number, a half up (request
 * 40). It is exact integer arithmetic, never a floating-point half.
 */
export const convertMinorUnits = (amount: number, from: CurrencyCode, to: CurrencyCode, rate: string): number => {
  const numerator = BigInt(amount) * scaleRate(rate) * 10n ** BigInt(MINOR_UNIT_DECIMALS[to]);
  const denominator = 10n ** BigInt(RATE_DIGITS + MINOR_UNIT_DECIMALS[from]);
  return Number((2n * numerator + denominator) / (2n * denominator));
};
