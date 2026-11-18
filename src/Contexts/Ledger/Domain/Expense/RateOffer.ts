/**
 * The rate a rates service offers for a currency to the group's on a day (request 22, ADR 15), as the port answers it: a
 * plain value the expense takes or refuses, never a call from the domain. `offered` carries the rate as the service writes
 * it; `none` is a service that offers no rate for it (a 404, an answer it does not give, or no answer in time); and
 * `unconfigured` is a server started without a rates service, which offers no rate and lets the payer's rate stand as
 * request 21 gives it.
 */
export type RateOffer = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'unconfigured' };

/**
 * Where the rate an expense was recorded at came from: `offered` when its rate was left out and the offer was taken;
 * `checked` when the payer stated it, within 2 % of the offer; `unchecked` when the payer stated it and no rates service
 * is configured (request 21). It is kept on the operation that recorded the expense, not on the expense.
 */
export type RateSource = 'offered' | 'checked' | 'unchecked';
