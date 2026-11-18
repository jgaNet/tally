/**
 * The rate a rates service offers from one currency to the group's, on a day (request 22), as Ledger takes it: a plain value
 * the expense takes or refuses (DOMAIN-NON-DETERMINISM). `offered` carries the rate as the service gave it, a decimal string;
 * `none` is no rate, whether the service has none, answers otherwise, or does not answer within 5 seconds; `unconfigured` is
 * no rates service at all (RATES_URL is not set), which takes the payer's rate as request 21 does.
 */
export type RateOffer = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'unconfigured' };
