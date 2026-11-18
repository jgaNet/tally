# 13. Ledger offers the rate of a rates service, and an expense in another currency takes or corrects it (the Groups → Ledger link, carried)

## Context

Request 22 has the rate of a currency to the group's offered by a rates service, an outside system with an API of its own
(`GET {RATES_URL}/rates/{from}/{to}?date={date}`). An expense in another currency (request 21) may leave its rate out and take
the offered one on its date, or state its rate and be refused when it differs from the offer by more than 2 %. The storm
`offered-rates` decided three hot spots with the product's owner: where the service sits in the model, who decides the band,
and what a server without a service does.

## Decision

- **The service is behind a port Ledger owns, in its Application layer** (`IOfferedRates`, `Ledger/Application/Ports`), named
  for what it decides: the rate from a currency to another on a day. Its answer is a plain value, `RateOffer` (ADR 12's rules
  for values; DOMAIN-NON-DETERMINISM), with three kinds: `offered` with the rate as the service gave it; `none`, for a service
  with no rate, an answer that is not a rate, or no answer within 5 seconds; `unconfigured`, when `RATES_URL` is not set. The
  adapter `HttpOfferedRates` reads `RATES_URL` when a rate is asked, the way Settlements reads `PROVIDER_URL` (ADR 11, T11).
- **The Expense decides the band.** `OriginalAmount` is the expense's value for an amount in another currency, and it settles
  the rate against the offer the handler gives it: a rate left out is the offered one, and none is refused as `NoRateOffered`.
  A stated rate is taken when no service is configured (request 21, whatever it is); with no offer it is refused as
  `NoRateOffered`; with an offer it is taken when `100 × |stated − offered| ≤ 2 × offered` in exact integer arithmetic (both
  ends included, so `0.931` and `0.969` are taken and `0.93` and `0.97` refused at 0.95 offered), and refused as
  `RateOutsideBand` otherwise.
- **The handler asks before the Expense decides,** through `offerForExpense`, only for an amount in another of Tally's
  currencies on a real day: anything else is refused by the Expense itself, without a call to the service. Recording and
  editing ask the same way (ADR 12).
- **The rate offered is read by a query, `GetOfferedRate`,** which answers the group's currency through the port Ledger
  already has from Groups (`GroupCurrency`), so the link gains no contract. A day left out is today; a currency that is the
  group's or not Tally's, a pair the service has no rate for, or a service that fails is `404`.

## Consequences

- No new context and no new relationship in the context map: the rates service is an outside system, declared as the
  payment provider is, and the Groups → Ledger link already carries `GroupCurrency`.
- The rate an expense keeps is the string it took, the offered one when it was left out: that is the provenance the API
  can show, read back as the rate (request 21). The operation's answer stays the expense's id, as it was: no column or
  response field was asked for, so the offer's origin is not stored separately.
- Tests of the existing requests run without `RATES_URL` and keep request 21's behaviour; the new ones set a fake service in
  process.

## When to revisit

When a group needs to show which of its expenses took an offered rate, rather than a stated one (then the origin is stored
with the expense, and the operation's answer carries it, which the API would have to say); or when the service must be asked
for days older than it keeps, or a rate must be fixed when a payment is made rather than when an expense is recorded.
