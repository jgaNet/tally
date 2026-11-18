# 15. Offered rates: a rates service behind a port Ledger owns, and an expense takes or checks the rate it offers

## Context

Request 21 lets a payer state the rate of an expense in another currency. Request 22 has Tally offer the day's rate from an
outside rates service (`GET {RATES_URL}/rates/{from}/{to}?date={date}`, `200 { rate }` or `404`), so that the payer takes
it when the rate is left out, and may correct it only within 2 % of it. The storm (`conventions/storms/offered-rates.yaml`)
decided three things before the run: that the service sits behind a port Ledger owns; that the expense, not the adapter,
decides the band; and that a server with no service is not the same as a service with no rate.

No context and no relationship between contexts is new: the rates service is an outside system, as the payment provider is
(ADR 8), and Ledger already has its relationship with Groups, which carries the group's currency (ADR 14). The context map is
unchanged.

## Decision

- **The rates service is a port Ledger owns** (`IOfferedRates`, in its Application layer, beside its other ports), named for
  what it decides: the rate offered from one currency to another on a day. Its adapter, `HttpOfferedRates`, calls
  `RATES_URL` with a 5-second limit. It answers `offered` with the rate, when the service gives a rate written as request 21
  writes one (a decimal number greater than 0, at most 6 digits after the point); `none` for a 404, any other answer, a rate
  not written so, or no answer in time; and `unconfigured` when `RATES_URL` is not set, asking nothing. The port never
  refuses: a value is a plain `RateOffer`, which the expense takes or refuses (DOMAIN-NON-DETERMINISM, as the provider's is).
- **The band is the Expense's, in its value** (`OriginalAmount.takeRate`, in exact integer arithmetic on millionths). A rate
  left out takes the offer, and is refused by name (`NoRateOffered`) when there is none. A rate given is first read as a
  decimal number greater than 0 (`InvalidRate`); with `unconfigured` it is kept, as request 21 keeps it; with `none` it is
  refused (`NoRateOffered`); with an offer it is kept when `|given − offered| × 50 ≤ offered`, that is within 2 % inclusive,
  and refused otherwise by name (`RateOutsideBand`).
- **The handler asks the port before the Expense decides**, once the expense's day is read: the offer is for that day. The
  command's result is the expense's id and where its rate came from (`rateSource`: `offered`, `checked`, `unchecked`; null
  in the group's currency). That is the provenance kept on the operation, which a client reads from `GET /v1/operations`.
- **A read of the offer** is `GetOfferedRate`: a member of the group reads the rate of a currency to the group's on a day
  (today when none is given). A non-member, a currency that is the group's or not Tally's, and a day with no offer are all
  `404`; a malformed day is `400`. The group's currency is read from Groups outside a transaction (`groupCurrencyForQueries`).
- **The composition root gives the port.** `createApplication` reads `RATES_URL` and builds the Ledger module with it
  (`ledgerModuleWith`), as it hands the payment provider to Settlements; the Ledger wiring is not a constant that reads the
  environment at import, so a test may set the variable before it builds the application.

## Consequences

- An expense in another currency may leave its rate out; the body's shape allows it (the rate is still a string when given),
  and the stored expense still reads its rate, as recorded.
- A server without `RATES_URL` records a stated rate as before (request 21) and refuses a rate left out, by name.
- A slow or failing service makes the offer absent for that command: a rate left out is refused, and a stated rate is
  refused too, since it cannot be checked. Nothing is kept on the Tally side then.
- The offered rate is read each time the expense is decided, so an edit takes the offer of its own day as it is now. Tally
  does not keep rates over time.

## When to revisit

If Tally keeps the rates it was offered (to show them, or to audit a conversion), a rate becomes a fact of its own, and the
expense keeps a reference to it. Until then the rate the payer stated, or took, is the one kept, once.
