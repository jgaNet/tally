# 31. A settlement in another currency is decided by its book at the rate a rates service offers, and Settlements owns the port that asks it

## Context

Request 39 of Tally (`api/39-settle-in-another-currency.yaml`, decided with the product's owner before the code, `conventions/storms/settle-in-another-currency.yaml`)
lets the payee of a cash settlement, or the payer of one through the provider, pay in another currency: Bob owes Ann 50 euros and has only Swiss francs
left. The rate is the one a rates service offers on the day the settlement is decided, in UTC, and the payer gives none. The settlement keeps the rate, so a
payment that lands days later, or a refund, counts the amount decided then. Through the provider, the provider is asked for the amount and currency paid,
and its fee, which it gives in that currency, converts at the same rate.

Request 22 already has an expense in another currency take such a rate (ADR 16, ADR 17): Ledger owns `IOfferedRates`, answered by `HttpOfferedRates` over
`RATES_URL`, and the conversion is Ledger's `OriginalAmount`. Settlements needs the same service for its own words, and the storm decided no relationship
between Ledger and Settlements for it: the rates service is an outside system, not a context.

## Decision

- **Settlements owns the port `ISettlementRates`** (`Settlements/Application/ISettlementRates.ts`), in its own words: `rateOf(from, to, date)`, answered
  with the rate as the service wrote it, or `undefined` when it offers none, does not answer well or in time, or is not configured. It is asked once
  per settlement, with the currency paid and the group's, on the day of the decision in UTC.
- **The adapter is `HttpSettlementRates`** (`Settlements/Infrastructure/`), over the same `RATES_URL`: `GET {RATES_URL}/rates/{from}/{to}?date={date}`,
  a 5-second limit, and anything but `200 { rate }` with a positive decimal of at most six digits after the point is no rate. The composition root gives
  it the URL, as it gives Ledger's. Two adapters over one service, each in its context's words, no link between the contexts.
- **The book converts.** `SettlementBook` takes the rate as an input (DOMAIN-NON-DETERMINISM): its draft carries the currency, the amount in that currency's
  hundredths and the offered rate, and `OriginalAmount` (`Settlements/Domain/Settlement/OriginalAmount.ts`) decides the settlement's amount in the group's
  currency, the original times the rate, rounded half up in exact integers. It refuses by name a currency that is not Tally's or the group's own, an
  amount out of 1 to 100 000 000, and no rate offered (`NoRateOffered`), before anything is kept, and the provider is not asked when there is none. The
  book is opened with its group's currency (`SettlementBookSnapshot.currency`), which the merge handler reads from Groups too.
- **The provider's fee converts the same way.** The provider answers its fee in the currency it was asked in; the book checks it is 0 or more and less than
  the amount paid, converts it at the settlement's rate, and keeps it as the settlement's `fee`, in the group's currency, before the part its payer bears is
  taken off (request 38).
- **Kept.** A settlement keeps its original and the rate as the service wrote it (`settlements.original_*`, read back through `OriginalAmount.kept`), so a
  later webhook or refund counts what was decided. A settlement in the group's currency keeps none and reads as before.
- **The body's shape only.** The route takes exactly one of `amount` (the group's currency) and `original` (`{ currency, amount }`); a body with neither, or
  with both, is `400`. A `rate` the payer sends is not read: the rate is the service's, never the payer's.

## Consequences

- The context map is unchanged. The storm's two links (Groups → Settlements for the members and currency, Ledger → Settlements for the balances) were
  already declared. The rates service is an outside system, which declares no relationship.
- A settlement in another currency makes one request to the rates service and waits for it at most 5 seconds; a service that does not answer in time
  refuses the settlement rather than deciding it at an unknown rate.
- The currency list and the conversion are Settlements' own copies of the six codes and of `OriginalAmount`, for the reason ADR 16 gives: a context does
  not import another context's domain, and a shared list would change the shared kernel, which this feature does not.

## When to revisit

When the rate must be fetched as of the time of the payment rather than the decision (a payment that lands later would then count a different rate, which
the product has not asked for), or when the rate must be kept with its source (ADR 17's provenance), which would add a field to the settlement's read model.
When a seventh currency is added, the list in Settlements, Ledger and Groups changes together, and so does the API fragment.
