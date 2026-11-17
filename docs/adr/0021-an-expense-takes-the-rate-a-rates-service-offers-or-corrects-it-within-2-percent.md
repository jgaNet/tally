# 21. An expense in another currency takes the rate a rates service offers, or corrects it within 2 %, and Ledger asks for it through a port

## Context

Request 22: nobody knows the franc's rate by heart. Tally offers the day's rate from a rates service, an outside system with an API
of its own (`GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }`, or `404`). The payer of an expense in another
currency (request 21, docs/adr/0020) takes that rate, or corrects it a little: an expense that gives its rate is refused when the
rate differs from the one offered by more than 2 % of it, and an expense that leaves its rate out is recorded at the one offered.

The storm (`conventions/storms/offered-rates.yaml`) decided three things before any code: the rates service is behind a port Ledger
owns in its Application layer (`IOfferedRates`), named for what it decides; the band is decided by the Expense, given the offer as an
input like any other, and refused by the rule's own name (`RateOutsideBand`); and a server without a rates service is not the same
answer as a service with no rate for the pair. The storm adds no context and no relationship between contexts: the rates service is
outside the application, not one of its contexts, so the context map is unchanged.

## Decision

- **The rate offered is a port Ledger owns, `IOfferedRates`, in Ledger's Application layer.** `offeredRate({ from, to, date })` answers
  an `OfferedRate`: `offered` with the rate, `none` when the service has no rate for the pair, or does not answer one in time, or
  answers anything that is not a rate, and `unavailable` when `RATES_URL` is not set. `HttpOfferedRates`, in Ledger's Infrastructure,
  calls the service over HTTP with a 5-second limit, as the payment provider's adapter does (T11). The base is read at each call.
- **The Expense decides, the handlers only ask.** Each use case that records or edits an expense in another currency asks the port
  for the rate on the expense's date, and passes the answer to the Expense as `offered`, like any other input: the handler asks it
  before the Expense decides, and nothing else. `OriginalAmount.create` and `recordedRate()` are pure functions of the given rate and
  the offer:
  - a rate left out takes the offered rate; with no rate offered (`none`, or `unavailable`), it is refused, `NoRateOffered`;
  - a rate given with no rates service (`unavailable`) stands, whatever it is (request 21, unchanged);
  - a rate given when the service offers none (`none`) is refused, `NoRateOffered`: there is nothing to compare it with;
  - a rate given against an offer is refused, `RateOutsideBand`, when it differs by more than 2 % of the offered rate. The band is
    measured exactly, in millionths: with `"0.95"` offered, `"0.931"` and `"0.969"` are taken and `"0.93"` and `"0.97"` refused.
  - a rate that is not a decimal of at most 6 digits, or is 0, is refused as it always was, whatever the offer.
- **The date comes before the amount.** The offer is the one on the expense's date, so a date that is not a real day, or is after
  today, is refused first (`InvalidDate`). The Expense's rules are otherwise as they were.
- **A query answers the offer.** `GetOfferedRate` (`GET /groups/{id}/rates/{currency}?date=`) answers `{ currency, date, rate }` to a
  member of the group, with the day asked or today (UTC) when it is left out. It answers `404` when no rate is offered (a `none` or
  `unavailable` answer), when the currency is the group's or not one of Tally's, when the day is not a real one, and to anyone who is
  not a member. It is read, never kept.
- **The rate is recorded as the string offered or given.** The expense keeps the rate it was recorded at and reads it back as given
  (request 21), so a later change of the service does not change a recorded expense.
- **The body's rate may be left out.** Request 22 says so; the request 21 body rule that required it is changed, and the response
  still always carries the rate, as request 21 says. The transport checks the shape only (API-BODY-SHAPE).

## Consequences

- No new context and no new relationship between contexts: the storm's only link is the one that carries `GroupCurrency` (ADR 0020).
  The rates service is an outside system, reached through a port of Ledger's own, so the context map is unchanged.
- An expense in another currency refused for want of a rate is an operation's refusal named by its rule, as every expense refusal is
  (requests 4, 6, 7, 21). The rates service is never asked for a currency that Tally does not know, or for the group's own currency.
- An expense recorded before this request, or with its rate given while no rates service is configured, is unchanged.
- `RATES_URL` is configuration like `PROVIDER_URL`: a server without it offers no rate, and takes the payer's rate, as before.

## When to revisit

When a rate must be kept as a fact of its own (a rate offered is read each time, and an expense keeps what it recorded; a conversion of
a balance or a re-read of old expenses at new rates would be a new decision); and when the band must differ by currency or by day.
