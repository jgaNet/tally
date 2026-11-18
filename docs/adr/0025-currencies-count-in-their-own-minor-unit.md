# 25. Currencies count in their own minor unit: the shared kernel names each currency with its decimals, and every context converts by them

## Context

Request 40 lets a group be in `JPY` or `KRW`, which have no minor unit, or in `KWD` or `BHD`, which count in thousandths, beside
Tally's six that count in hundredths. Every amount the API names is then a whole number of the minor unit of the currency it is in:
`1250` is 12.50 in `EUR` and 1250 yen in `JPY`. Until now the hundredths were assumed everywhere: the list of currencies was written
out in Groups, Ledger, Settlements (for the settlements and for netting) and in the rate and group schemas, and the conversions of an
original amount (ADR 12, ADR 24) divided by 100 in effect. The reminders' threshold, 2000 for a debt, was a count of hundredths
(ADR 10, request 18). The storm `currency-precision` decided four hot spots with the product's owner: where a currency's minor unit is
read; what changes in the conversions; the threshold of a reminder in each currency; and that nothing stored is converted.

## Decision

- **The minor unit is in the shared kernel.** `SharedKernel/Domain/Currency.ts` holds the one table of Tally's currencies and their
  number of decimals (`EUR`, `USD`, `GBP`, `CHF`, `CAD`, `AUD`: 2; `JPY`, `KRW`: 0; `KWD`, `BHD`: 3), `isCurrency`, `decimalsOf`, and a
  `Currency` value object over the code with its `decimals` and `minorUnit`. Every context reads its list from here. The shared kernel
  imports no context, and the building blocks import nothing of it; a change to the shared kernel is an architecture change, decided
  here (`architecture.yaml`, the architecture mode). No relationship between contexts is added or changed.
- **Each conversion is in its context, by the currencies' decimals.** The original amount of Ledger (an expense) and of Settlements
  (a settlement) reads the amount in its currency's units and writes the result in the group's minor unit, a half rounded up, in exact
  integer arithmetic: `amount × rate × 10^toDecimals / 10^(fromDecimals + 6)`. Between two currencies of hundredths this is the amount
  times the rate, as it was. Each context keeps its own copy of the rule and its tests hold it (ADR 24): the rounding is one rule in two
  places, and a shared value for it would have been a second shared decision for no gain.
- **An expense's group amount takes the group's currency when it is computed.** `OriginalAmount.inGroupCurrency` is given the group's
  currency. An expense read back (`fromSnapshot`) does not convert again: its snapshot does not keep the group's currency, and its
  amount was decided when it was recorded. Its original amount is still checked for its own values.
- **A settlement keeps its group's currency with its original amount,** so the provider's fee, given in the payment's currency, is
  converted to the group's minor unit at the rate the settlement was decided at (request 38).
- **Reminders are for more than 20 of the group's currency.** `lingeringDebtOver(currency)` is 20 in the currency's minor unit: 2000 in
  EUR, 20 in JPY, 20 000 in KWD. The group's currency reaches Notifications through Settlements' answer of what is owed (`OutstandingDebt`)
  and, through it, Groups' membership answer, which already carries each group. This is a new field on existing answers (ADR 10), not a
  new relationship. A member whose debt is noted and who owes nothing is decided as owing 0, which clears the note at any threshold,
  so no currency is read for them.
- **Nothing stored is converted.** Every amount kept before this change was in hundredths, in a currency of hundredths, and reads as it
  did. No column changes and no data is moved: the upgrade test reads the stored amounts through the tree at request 39 and through this
  one, on the same database.

## Consequences

- `yarn architecture storm --expect conventions/storms/currency-precision.yaml` owes nothing; the storm is marked done.
- The API adds `JPY`, `KRW`, `KWD` and `BHD` to every enum that names a currency (a group's, a rate's, an expense's and a settlement's
  `original.currency`); the fragment is `api/40-currency-precision.yaml`.
- A group in `JPY` or `KWD` has its reminders at 20 yen or 20 dinars, and a debt of 20 is not reminded in either.
- The `Currency` class of Groups keeps its own refusal (`UnsupportedCurrency`); the shared one refuses with `UnknownCurrencyCode`.

## When to revisit

When a currency is added (one line in the shared table, and a fragment), or when a currency's minor unit is not a power of ten: the
conversion and the threshold both assume `10^decimals`. When the rounding rule changes, it changes in both conversions together, and
the two specs hold each to it.
