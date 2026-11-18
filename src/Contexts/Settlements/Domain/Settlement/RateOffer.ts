/**
 * The rate a rates service offers from one currency to the group's, on a day (request 22), as Settlements takes it: a plain value
 * the SettlementBook takes or refuses (DOMAIN-NON-DETERMINISM). `offered` carries the rate as the service gave it, a decimal string;
 * `none` is no rate, whether the service has none, answers otherwise, or does not answer within 5 seconds; `unconfigured` is no
 * rates service at all (RATES_URL is not set). A settlement in another currency takes only `offered`: any other answer refuses it.
 */
export type RateOffer = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'unconfigured' };
