# 13. An offered rate is a port the expense takes or checks within 2 %, and its source is kept

## Context

Request 22 lets Tally offer the day's rate from a rates service, an outside system with an API of its own: a member reads the
rate offered from a currency to the group's on a day; an expense in another currency (request 21) may leave out its rate and
take the one offered for its day, or state one that differs from it by no more than 2 %. The storm
(`conventions/storms/offered-rates.yaml`) decided three hot spots: where the rates service sits in the model, who decides the
band, and what a server without a rates service does.

The rates service is not a context, and no relationship between contexts is added: the expense is Ledger's and the group's
currency already comes through the owned port of ADR 12. So the context map and `conventions/domain.yaml` are unchanged.

## Decision

- **The rates service is a port Ledger owns, and the answer is a plain value.** `IOfferedRates` (`Ledger/Application/Ports`)
  answers `rateOn({ from, to, date })` with a `RateOffer` (`Ledger/Domain/Expense/RateOffer.ts`): `offered` with the rate as the
  service gave it; `none` for any answer that is not a rate (a 404, another answer, a rate that is not valid, no answer within 5
  seconds); or `no-service` when `RATES_URL` is not set. The adapter is `HttpRatesService`, which reads `RATES_URL` when it is
  asked, as the payment provider's adapter reads `PROVIDER_URL` (ADR 8). A request that cannot name two of Tally's currencies and
  a `YYYY-MM-DD` day is not sent.
- **The expense settles the rate, and the handler only asks.** `OriginalAmount` (Ledger's domain) decides the rate of what was
  paid, after the day is checked. A rate left out is taken from the offer. A stated rate is taken as it is given when the offer is
  `no-service`; refused as `NoRateOffered` when there is no offer, left out or stated; and otherwise taken only when it differs
  from the offer by no more than 2 %, checked in exact integer arithmetic (`|stated − offered| × 50 ≤ offered`, so the boundary is
  taken), and refused as `RateOutsideBand` beyond it. The command handlers (record and edit) ask the port before the expense
  decides, and only for an expense whose money is in another currency; the decision is in the aggregate, not in the handler.
- **The day is checked before the money.** `Expense.decide` checks the day first, so a day that is not a real one is refused as
  `InvalidDate` whatever the rate, and no offer for it is taken for a refusal of its own.
- **The source of the rate is kept on the expense, not exposed.** Contract (DOMAIN-NON-DETERMINISM) asks for the provenance to
  end on the operation; the operation's result is the expense's id by request 1, so the provenance is kept beside the rate: a
  `rateSource` (`stated` or `offered`), stored in one nullable column (`original_rate_source`, NULL is `stated`, as every rate kept
  before offers was). It is not in the API: the read gives the rate, as request 21 does.
- **The query reads the offer through the same port.** `GetOfferedRate` (`GET /groups/{id}/rates/{currency}`) is a member's read: a
  404 when no rate is offered, when the currency is the group's own or not Tally's, or to anyone who is not a member; a 400 for a day
  that is not a real one or is in the future, as an expense's day is. The day defaults to today, from the application's clock.
- **Transport.** A body's `original.rate` is a string that may be left out; a rate given as a number is still of the wrong shape
  (400). The read keeps `rate` required, since an expense always has one.
- **Tests.** Unit tests in `OriginalAmount.spec.ts` cover the band, its boundary, the offers, and the source; the end-to-end spec
  `offered-rates.routes.e2e.spec.ts` runs a stand-in rates service over HTTP and holds the query, the take and correct rules, the
  refusals by name, the server without a rates service, and the edit.

## Consequences

- An expense's rate is decided once, when it is recorded or edited; a later change of the service's rate does not move it.
- The ask is made inside the command's transaction, as the payment provider's is (ADR 8), so the file is held for up to 5 seconds
  while the service answers. That is accepted for a request that is not a bulk read.
- A server without `RATES_URL` records a stated rate as it is given, as request 21 did, and refuses a rate left out, since there is
  no offer to take.

## When to revisit

If the rate should be fetched by the domain on its own (a feed, a daily job that stores rates), that is a new port and a decision of
its own; the band and the source would stay as they are. If an expense should show its source in the API, the read model gains a
field, which is a new request and a new fragment.
