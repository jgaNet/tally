/**
 * The currencies Tally knows. Each has a minor unit, the smallest amount written in it: an amount is a whole number of its
 * currency's minor unit, so `1250` is 12.50 in EUR (hundredths), 1250 in JPY (no minor unit) and 1.250 in KWD (thousandths).
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * The decimal places of each currency's minor unit: 2 for hundredths (cents, pence), 0 for a currency with no minor unit,
 * 3 for thousandths.
 */
export const MINOR_UNIT_DIGITS: Readonly<Record<Currency, number>> = {
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

/** The decimal places of a currency's minor unit (see {@link MINOR_UNIT_DIGITS}). */
export function minorUnitDigitsOf(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}

/** The currencies as a SQL list of string literals, for a CHECK: `'EUR', 'USD', …`. */
export const CURRENCY_SQL_LIST = CURRENCIES.map(currency => `'${currency}'`).join(', ');
