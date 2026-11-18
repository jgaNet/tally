/**
 * The currencies Tally knows (request 2): a group is in one of them, fixed when it is created, and an expense may be paid in
 * another of them (request 21). Each counts in hundredths (cents, pence). Shared by the contexts that need the same list
 * (ADR 18): neither context imports the other to know it.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Whether `raw` is one of Tally's currencies. */
export const isCurrencyCode = (raw: string): raw is CurrencyCode => (CURRENCIES as readonly string[]).includes(raw);
