/**
 * The currencies of Tally (request 2, request 40): a group is in one of them, fixed when it is made, and an expense or a settlement may be
 * paid in another one (requests 21 and 39). Each has its own minor unit (docs/adr/0039): yen and won have none, most count in hundredths,
 * cents or pence, and dinars count in thousandths. Every amount of Tally is a whole number of the minor unit of its currency.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

/** The number of decimals of each currency's minor unit: `1250` is 12.50 in `EUR` and 1250 in `JPY`, and 1.250 in `KWD`. */
const DECIMALS: Record<CurrencyCode, number> = {
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
};

/** The number of decimals of a currency's minor unit: 0 for yen and won, 2 for most, 3 for dinars. */
export function decimalsOf(code: CurrencyCode): number {
  return DECIMALS[code];
}

/** Whether `raw` is one of Tally's currencies, by its code, exactly. */
export const isCurrencyCode = (raw: unknown): raw is CurrencyCode => (CURRENCIES as readonly unknown[]).includes(raw);

/** A rate is kept as an integer of millionths, so that its product with an amount is exact (request 21, request 22). */
const MILLIONTHS = 1_000_000n;

/** A rate, as a payer states it or a service offers it: a decimal written as a string, with at most 6 digits after the point. */
export const RATE_SHAPE = /^\d+(\.\d{1,6})?$/;

/** The rate in millionths: `"12.5"` is 12 500 000. Only read once the rate is checked with `RATE_SHAPE`. */
export function rateInMillionths(rate: string): bigint {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(6, '0'));
}

/**
 * An amount in one currency, converted to another (docs/adr/0039): `rate` is what one unit of `from` (one yen, one euro, one dinar) is worth
 * in `to`. The result is the amount in `to`'s minor unit: the amount, read in `from`'s units, times the rate, in `to`'s units, written in
 * `to`'s minor unit, to the nearest whole number, a half up. It is computed in integers, never in floating point: `1250` euros at `"161.5"`
 * is 2018.75 yen, which is `2019`; `1000` dollars at `"0.3075"` is 3.075 dinars, which is `3075`.
 */
export function convertMinorUnits(amount: number, from: CurrencyCode, rate: string, to: CurrencyCode): number {
  const shift = decimalsOf(to) - decimalsOf(from);
  // amount * rate / 10^6 * 10^shift, as the fraction numerator / denominator.
  const numerator = BigInt(amount) * rateInMillionths(rate) * 10n ** BigInt(Math.max(shift, 0));
  const denominator = MILLIONTHS * 10n ** BigInt(Math.max(-shift, 0));
  return Number((numerator + denominator / 2n) / denominator);
}
