/**
 * A rate: a decimal number written as a string, greater than 0, with at most 6 digits after the point (request 21). It is held
 * in millionths, so a rate of six digits after the point is a whole number of them.
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
 * The band a payer's rate must stay in, around the offered one (request 22): 2 % of the offered rate, in either direction, both
 * edges included. Computed in millionths, in integers: |given - offered| * 100 <= 2 * offered.
 */
export const withinBand = (given: string, offered: string): boolean => {
  const g = rateInMillionths(given);
  const o = rateInMillionths(offered);
  const difference = g > o ? g - o : o - g;
  return difference * 100n <= 2n * o;
};

/**
 * What the rates service offers for a currency to the group's on a day, as the expense takes it (request 22, ADR 19):
 * - `rate`: the service offers this rate, as it gives it (a rate `isRate` accepts);
 * - `none`: the service has no rate for it, or did not answer as it should, or did not answer in time: nothing is offered;
 * - `no-service`: the server has no rates service at all. An expense then takes the payer's rate, as request 21 says, which
 *   is not the same as `none`, that refuses it.
 */
export type RateOffer = { kind: 'rate'; rate: string } | { kind: 'none' } | { kind: 'no-service' };

/**
 * The offer an expense takes when no rate was asked for it: the rates service is not asked for an amount in the group's own currency,
 * nor for a currency that is not Tally's or a day that is not written as one, so the decision never reads an offer for those
 * (the currency and the day are refused first).
 */
export const NOT_ASKED: RateOffer = { kind: 'none' };

/** The offer of a server without a rates service: the payer's rate is taken whatever it is (request 21). */
export const NO_SERVICE: RateOffer = { kind: 'no-service' };
