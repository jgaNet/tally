import { Refusal } from '../refusal';
import { charLength } from '../text';

/** The currencies a group can be in. Each counts its amounts in hundredths (cents, pence). */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

export type Currency = (typeof CURRENCIES)[number];

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
