import { rateInMillionths } from '@SharedKernel/Domain';

/** A rate, and its arithmetic, are the shared kernel's: an expense and a settlement convert at one the same way (ADR 37). */
export { isRate, rateInMillionths } from '@SharedKernel/Domain';

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
