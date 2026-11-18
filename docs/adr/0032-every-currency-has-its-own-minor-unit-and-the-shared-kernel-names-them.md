# 32. Every currency has its own minor unit, and the shared kernel names the currencies

## Context

Request 40 of Tally (`api/40-currency-precision.yaml`, decided with the product's owner before the code, `conventions/storms/currency-precision.yaml`)
adds four currencies to Tally's six: `JPY` and `KRW`, which have no minor unit, and `KWD` and `BHD`, which count in thousandths. Until now every amount was
an integer of hundredths, and the rule was written into four places: Groups' `Currency` (ADR 5), Ledger's and Settlements' copies of the six codes and
their `OriginalAmount` (ADR 16, ADR 31), and Notifications' reminder threshold of 2000 hundredths (ADR 14).

Each of those places needs the same fact, the number of decimals of a currency's minor unit, and Ledger, Settlements and Notifications each need it in
their own words. ADR 31 kept Settlements' own copy of the list, for the reason that a shared list would change the shared kernel, which a feature does not.
This feature is the one that changes it: the storm decided that the minor unit is a word every context agrees on.

## Decision

- **The shared kernel owns `Currency`** (`src/SharedKernel/Domain/Currency.ts`): the ten codes, each with the number of decimals of its minor unit (2 for
  the six, 0 for `JPY` and `KRW`, 3 for `KWD` and `BHD`). It has `create`, which refuses a code that is not Tally's by name (`UnsupportedCurrency`, `422`),
  `isCode`, and `decimalsOf`. Groups creates a group in it, and its `Currency` is the shared one; the context's copy is removed.
- **Conversion is one function.** `convertMinorUnits(amount, from, to, rate)` is the amount in `from`'s minor unit times the rate (millionths of `to` per one
  unit of `from`), in `to`'s minor unit, rounded to the nearest whole number, a half up, in exact integers. Ledger's `OriginalAmount` and Settlements'
  `OriginalAmount` each call it: an expense or a settlement in another currency converts through it, and so does a provider's fee in that currency.
  Between two currencies of the same decimals it gives what it gave before.
- **The reminder threshold is per currency.** `reminderThresholdOf(currency)` is 20 of the group's currency in its minor unit: 2000 euros' hundredths, 20 yen,
  20 000 dinars' thousandths. Notifications' `OutstandingDebt` carries the group's `currency`, which Settlements' `OwedDebt` carries from Groups' roster,
  the same roster Settlements already reads through `SettlementMembers`. One field added to an existing contract; no relationship is new.
- **Nothing stored is converted.** Every amount kept was an integer of a currency that counts in hundredths, and it is read as it was. No migration.

## Consequences

- The shared kernel is larger by one concept: a change to `Currency` reaches every context. It is decided here, in this ADR, and the feature mode refuses it.
- An expense's load no longer re-checks its amount in the group's currency. The snapshot keeps neither the group's currency nor that amount, and the
  conversion needs the first; the amount was decided and checked when the expense was recorded or edited, in the same transaction that wrote it. Loading checks
  the original alone: its currency is Tally's, its rate is a positive decimal, and its amount is an amount, else it throws as corrupted.
- A seventh currency is one line in `DECIMALS` and one line in the API fragment. The contexts do not change.

## When to revisit

When a currency's minor unit changes after it has been used (the currency is then a new code, not an edited one), or when a snapshot must check an expense's
amount in the group's currency on load, which would need the group's currency kept with the expense.
