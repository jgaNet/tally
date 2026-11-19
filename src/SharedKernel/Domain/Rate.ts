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
 * An amount in hundredths of one currency, converted at a rate: the amount times the rate, rounded to the nearest whole number, a half
 * rounded up, computed in exact integer arithmetic and never in floating point. Only called on a rate `isRate` accepts.
 */
export const convertAtRate = (amount: number, rate: string): number => {
  const product = BigInt(amount) * rateInMillionths(rate);
  // round(product / 10^6) with a half rounded up, in integers: floor((2 * product + 10^6) / (2 * 10^6)).
  return Number((2n * product + RATE_SCALE) / (2n * RATE_SCALE));
};
