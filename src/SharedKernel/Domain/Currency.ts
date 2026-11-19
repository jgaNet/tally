/**
 * The currencies Tally counts in, each with the decimals of its minor unit (request 40, ADR 30): EUR, USD, GBP, CHF, CAD and AUD
 * count in hundredths, JPY and KRW have no minor unit, KWD and BHD count in thousandths. Every amount is a whole number of
 * the minor unit of the currency it is in, so `1250` is 12.50 euros, 1250 yen and 1.250 dinars.
 */
export const CURRENCY_DECIMALS = {
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

export type CurrencyCode = keyof typeof CURRENCY_DECIMALS;

/** Tally's currencies, in the order they are listed (the order a refusal names them in). */
export const CURRENCY_CODES: readonly CurrencyCode[] = Object.keys(CURRENCY_DECIMALS) as CurrencyCode[];

/** Whether `raw` is one of Tally's currencies. */
export function isCurrencyCode(raw: unknown): raw is CurrencyCode {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, raw);
}

/** How many minor units make one unit of the currency: 100 for euros, 1 for yen, 1000 for dinars. */
export function minorUnitsPerUnit(currency: CurrencyCode): number {
  return 10 ** CURRENCY_DECIMALS[currency];
}

const MILLION = 1_000_000n;

/**
 * An amount of `from`, in its minor unit, in `to`, in its minor unit, at a rate: what one unit of `from` is worth in `to`, a
 * decimal number of at most six digits after the point, written as a string (the rate as the rates service and the payer
 * give it). The result is the amount times the rate, moved to the minor unit of `to`, to the nearest whole number, a half
 * rounded up. The arithmetic is exact: the rate is read as a whole number of millionths and never as a floating point number.
 * Between two currencies that have the same decimals, this is the amount times the rate.
 */
export function convertMinorUnits({
  amount,
  from,
  to,
  rate,
}: {
  amount: number;
  from: string;
  to: string;
  rate: string;
}): number {
  // The callers check their currencies first (as a refusal); a currency that is not Tally's here is a programming error.
  if (!isCurrencyCode(from) || !isCurrencyCode(to)) throw new Error(`Not a currency of Tally: ${from} to ${to}`);
  const [whole, fraction = ''] = rate.split('.');
  const millionths = BigInt(whole + fraction.padEnd(6, '0'));
  const shift = CURRENCY_DECIMALS[to] - CURRENCY_DECIMALS[from];
  // Both factors of the division are whole powers of ten, so the divisor is even and a half is a whole number.
  const numerator = BigInt(amount) * millionths * 10n ** BigInt(Math.max(shift, 0));
  const denominator = MILLION * 10n ** BigInt(Math.max(-shift, 0));
  return Number((numerator + denominator / 2n) / denominator);
}
