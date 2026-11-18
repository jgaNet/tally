# 17. Offered rates are a port Ledger owns, and the 2 % band is the expense's rule

## Context

Request 22 of Tally (`conventions/storms/offered-rates.yaml`, decided with the product's owner before the code) has the payer of an
expense in another currency take the rate a rates service offers when their own rate is left out, and correct it by at most 2 % of
the offered one. The rates service is an outside system with an HTTP API of its own (`RATES_URL`), not a context of Tally, and the
storm declares no new relationship between contexts: it only adds what Ledger asks of the rates service.

The rate is a fact about the world on a day, not a function of Tally's state, so it is the kind of decision DOMAIN-NON-DETERMINISM
says enters the domain as a value the aggregate validates and may refuse.

## Decision

- **Ledger owns the port `IOfferedRates`** (`Ledger/Application/IOfferedRates.ts`), in its own words: `rateOf(from, to, date)`, the
  rate one `from` is worth in `to` on `date`. Its answer is one of three plain values (`OfferedRate`, in the Expense's Domain): the rate
  as the service wrote it, no rate, or no rates service at all (`RATES_URL` not set). The distinction is kept, because the storm decided
  that a server without a service takes the payer's rate (request 21), and a service with no rate refuses it.
- **The adapter is `HttpOfferedRates`** (`Ledger/Infrastructure/`): `GET {RATES_URL}/rates/{from}/{to}?date={date}`, a 5-second limit, and
  anything but `200 { rate }` with a rate that is a positive decimal with at most six digits after the point is no rate. It never throws.
  The composition root builds it from `RATES_URL`, as it builds the payment provider from `PROVIDER_URL`.
- **The band is the Expense's rule** (`OriginalAmount.decide`), given the offer like any other input. A rate left out takes the offered
  rate. A rate stated is kept when no service is configured (request 21), and otherwise must lie within 2 % of the offered rate, inclusive,
  measured in exact millionths (`RateOutsideBand`). With no rate offered, a rate left out or stated is refused (`NoRateOffered`). The
  rate the expense keeps is the one it was recorded at, read back as given.
- **The handler asks the port before the Expense decides**, for an expense with an original (recording and editing), and only then. The
  port is asked with the expense's own currency and day, so the offer is the one for the day the expense is spent.
- **`GetOfferedRate` is a query** of Ledger, answered to a member of the group at `GET /v1/groups/{id}/rates/{currency}`: `200 { currency,
  date, rate }`, or `404` (for a non-member, the same `404` as a group that is not there). A day is today when none is given, and a day
  that is not a real one is `404` without asking the service.

## Consequences

- The context map is unchanged: the storm's only link (Groups → Ledger, GroupCurrency and GroupMembers) is already declared, and an
  outbound adapter to an external system is not a relationship between contexts.
- A recording or an edit in another currency makes one request to the rates service, and waits for it at most 5 seconds. A slow service
  therefore slows the expense, and refuses it when it does not answer in time, rather than recording it at an unknown rate.
- The "provenance" the storm named ("keeps the offer's provenance on the operation") is the rate the expense keeps: Lite commands answer
  at once and have no operation to keep anything on, and the API does not say where a rate came from. Whether a stated and an offered rate
  should be told apart on the expense is left for a request that needs it.

## When to revisit

When the rate must be fetched as of the time of the payment rather than the expense's day, or when a rate must be kept with its source
(the provenance above), which would add a column and a field to the expense's read model. When the band must differ by currency, which
would be a decision about the product, not the code.
