# 19. An offered rate is a port Ledger owns, and "no rate" and "no rates service" are different answers

## Context

Request 22 lets Tally offer the day's rate from a rates service, outside Tally, for a currency to the group's. An expense in another
currency (request 21) takes that rate when its payer leaves their own out, and is refused when its own rate is more than 2 % from it.
Three facts shape the design:

- the rates service is outside the system: it is reached over HTTP, at `RATES_URL`, and may be slow, down, or wrong;
- the decision about an expense's rate is a decision of the expense (the band and the offer are facts about the expense's values), so the
  answer of the service must be a plain value the expense takes or refuses, never a call made inside the decision (DOMAIN-NON-DETERMINISM,
  as the payment provider's answer is, T11, ADR 12);
- a server started without `RATES_URL` has no rates service at all. Request 21 says it takes the payer's rate whatever it is; a service that
  answers that it has no rate for a currency and day refuses an expense that leaves its rate out. These are not the same answer.

The storm (`conventions/storms/offered-rates.yaml`) decided these three hot spots before the code.

## Decision

- **A port Ledger owns, `IOfferedRates`** (`rateFor({ from, to, date })`), in Ledger's Application layer, in its own words (ADR 5, ADR 18). It is
  answered by `OfferedRatesOverHttp`, which reads `RATES_URL` when a request comes (ADR 7), calls `GET {RATES_URL}/rates/{from}/{to}?date=`
  with a 5-second limit, and maps everything that is not a rate in the request-21 shape to "none".
- **The answer is a value, `RateOffer`:** `rate` (the service offers this rate, as it gives it), `none` (the service has no rate, did not
  answer as it should, or did not answer in time), or `no-service` (no `RATES_URL`). The Expense takes or refuses it; the port is asked
  before the decision, in the use case, and never inside it. The use case asks only for an amount paid in another currency, for a currency
  Tally knows and not the group's, on a day written as one.
- **The band is the Expense's rule, by its name.** A rate left out takes the offered one, and is refused by name (`NoRateOffered`) when none
  is offered. A rate given is refused as `RateOutsideBand` when it differs from the offered one by more than 2 % of it, both edges included,
  compared in exact millionths (|given − offered| × 100 ≤ 2 × offered). A rate given is refused as `NoRateOffered` when none is offered to
  compare it with, and taken as it is under `no-service`, as request 21 says.
- **The day is checked before the amount**, so a day that is not a day is refused as one and never reaches a rate question.
- **Asked by a member, as the query `GetOfferedRate`:** `GET /groups/{id}/rates/{currency}?date=` answers `{ currency, date, rate }`, with
  today's UTC day when `date` is left out. A currency that is the group's or not one of Tally's, and a rate that is not offered, both answer
  `404`; a day that is not a real day answers `400` by name (`InvalidRateDate`).

## Consequences

- The map does not change: the rates service is outside the system, and no context of Tally is related to it. The relationship Groups → Ledger
  (`GroupCurrency`) is unchanged, as ADR 18 declared it.
- The rate an expense keeps is the one it was counted at, whether it was given or offered; read back as it was (request 21). The expense does
  not keep *which* of the two it took. The hot spot asked for the offer's provenance on the operation; the Lite profile answers a command at
  once, with no operation to keep it on, and the request's API does not ask for it, so none is kept.
- A rates service that is down, or that answers junk, looks to the user like one that has no rate for the day: both refuse an expense that
  leaves its rate out, by the same name. The difference is kept in the answer of the port (`none` and `no-service`), not in the message.
- Nothing is stored outside the expense: an offer is asked for when a decision is made and kept only as the rate it gave.

## When to revisit

If an expense must record which source its rate came from (the service, the payer, or none at all), the expense keeps that as a value of
its own and this record is superseded. If the rates service is to be asked in a transaction-free step (for instance when the rate is fetched
ahead of the decision and cached), the port's answer must still be a plain value, and the time-out must still refuse a rate that does not
arrive in time.
