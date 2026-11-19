import { minorUnitDecimals } from './Currency';

/**
 * A rate (request 21, request 22): a decimal number written as a string, greater than 0, with at most 6 digits after the point. It is held
 * in millionths, so a rate of six digits after the point is a whole number of them. Shared by the contexts that convert an amount at one
 * (ADR 37): an expense paid in another currency (Ledger) and a settlement paid in another one (Settlements) are converted the same way.
 */
const RATE_FORMAT = /^\d+(\.\d{1,6})?$/;
const RATE_SCALE = 1_000_000n;

/** Whether `raw` is a rate as the API writes one: a decimal number in a string, greater than 0, at most 6 digits after the point. */
export const isRate = (raw: unknown): raw is string =>
  typeof raw === 'string' && RATE_FORMAT.test(raw) && rateInMillionths(raw) > 0n;

/** The rate as a whole number of millionths: "12.5" is 12 500 000. Only called on a rate `isRate` accepts. */
export const rateInMillionths = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
};

/**
 * An amount in the minor unit of one currency, converted at a rate into the minor unit of another (ADR 38): one unit of `from` is worth `rate`
 * units of `to`, so the amount in `to`'s minor unit is the amount times the rate, times 10 to the power of `to`'s decimals and divided by 10
 * to the power of `from`'s, rounded to the nearest whole number, a half rounded up, computed in exact integer arithmetic and never in floating
 * point. Between two currencies of the same decimals it is the amount times the rate, as it always was. Only called on a rate `isRate`
 * accepts, and on currencies `minorUnitDecimals` accepts.
 */
export const convertAtRate = (amount: number, rate: string, from: string, to: string): number => {
  const numerator = BigInt(amount) * rateInMillionths(rate) * 10n ** BigInt(minorUnitDecimals(to));
  const denominator = 10n ** BigInt(minorUnitDecimals(from)) * RATE_SCALE;
  // round(numerator / denominator) with a half rounded up, in integers: floor((2 * numerator + denominator) / (2 * denominator)).
  return Number((2n * numerator + denominator) / (2n * denominator));
};
