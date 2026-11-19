/**
 * The currencies Tally knows (request 2, request 40): a group is in one of them, fixed when it is created, and an expense or a settlement may
 * be paid in another of them (requests 21, 39). Each counts in its own minor unit (ADR 38): none for JPY and KRW, hundredths for the six of
 * request 2, thousandths for KWD and BHD. Shared by the contexts that need the same list (ADR 18): neither context imports the other to know it.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** The number of decimals of each currency's minor unit: `1250` is 12.50 in a currency with 2, 1250 in one with 0, 1.250 in one with 3. */
const MINOR_UNIT_DECIMALS: Record<CurrencyCode, number> = {
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

/** Whether `raw` is one of Tally's currencies. */
export const isCurrencyCode = (raw: string): raw is CurrencyCode => (CURRENCIES as readonly string[]).includes(raw);

/**
 * The decimals of a currency's minor unit (ADR 38). Only called on a currency that `isCurrencyCode` accepts: any other is a programming
 * error, and throws.
 */
export const minorUnitDecimals = (raw: string): number => {
  if (!isCurrencyCode(raw)) throw new Error(`${raw} is not one of Tally's currencies`);
  return MINOR_UNIT_DECIMALS[raw];
};
