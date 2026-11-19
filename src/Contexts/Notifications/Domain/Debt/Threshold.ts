import { isCurrencyCode, minorUnitsPerUnit } from '@SharedKernel/Domain';

/** A debt is over this many units of its group's currency (request 18, request 40): more than 20 of it, whatever the currency. */
export const DEBT_THRESHOLD_UNITS = 20;

/**
 * The amount a debt must be over, in its group's currency's minor unit (request 18, request 40): 2000 in euros (more than 20.00),
 * 20 in yen (more than 20 yen), 20000 in dinars (more than 20.000 dinars).
 */
export function debtThresholdOf(currency: string): number {
  if (!isCurrencyCode(currency)) throw new Error(`Not a currency of Tally: ${currency}`);
  return DEBT_THRESHOLD_UNITS * minorUnitsPerUnit(currency);
}
