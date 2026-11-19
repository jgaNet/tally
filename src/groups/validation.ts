import { Refusal } from '../refusal';
import { charLength } from '../text';

/** The currencies a group can be in. Each counts its amounts in its own minor unit, as `MINOR_UNIT_DIGITS` says. */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'] as const;

export type Currency = (typeof CURRENCIES)[number];

/**
 * The decimal digits of each currency's minor unit: an amount is a whole number of it. Most count in hundredths (cents,
 * pence), 2 digits; yen and won have no minor unit, 0 digits; dinars count in thousandths, 3 digits.
 */
const MINOR_UNIT_DIGITS: Record<Currency, number> = {
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

/** The decimal digits of the minor unit of `currency`: 2 for hundredths, 0 for a currency with none, 3 for thousandths. */
export function minorUnitDigitsOf(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}

export interface GroupInput {
  name: string;
  currency: string;
}

export interface ValidGroup {
  /** Trimmed. */
  name: string;
  currency: Currency;
}

/** Checks a new group. Refusals are `422`: the body had the right shape, a value is not allowed. */
export function validateGroup(input: GroupInput): ValidGroup {
  const name = input.name.trim();
  if (charLength(name) < 1 || charLength(name) > 60) {
    throw new Refusal(422, 'InvalidName', 'The name must have between 1 and 60 characters, not only spaces.');
  }

  if (!(CURRENCIES as readonly string[]).includes(input.currency)) {
    throw new Refusal(422, 'InvalidCurrency', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }

  return { name, currency: input.currency as Currency };
}
