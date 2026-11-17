/**
 * The currencies of Tally (request 2): a group is in one of them, fixed when it is made, and an expense may be paid in another
 * one (request 21). Each counts in hundredths, cents or pence: every amount is an integer of them.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];
