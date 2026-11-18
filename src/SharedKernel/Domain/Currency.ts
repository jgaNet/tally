/**
 * The currencies Tally counts in (request 2): a group is in one of them, and an expense may be paid in another of them. The
 * list is the one published fact about money every context agrees on, so it lives in the shared kernel, not in one context.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export const isCurrencyCode = (raw: string): raw is CurrencyCode => (CURRENCIES as readonly string[]).includes(raw);
