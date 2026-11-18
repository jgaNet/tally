/**
 * What the rates service offers for a currency to the group's on a day, as the port answers it (DOMAIN-NON-DETERMINISM, ADR 13):
 * - `offered`: the service's rate, written as it gave it (a decimal number in a string, above 0, at most 6 digits after the point);
 * - `none`: no rate, for any answer that is not one: a 404, another answer, no answer within the limit, or a rate that is not valid;
 * - `no-service`: no rates service is configured (`RATES_URL` is not set), so there is nothing to ask and the payer's rate stands.
 */
export type RateOffer = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'no-service' };
