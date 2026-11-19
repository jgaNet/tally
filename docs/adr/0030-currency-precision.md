# 30. Currencies with no minor unit or with three decimals: the shared kernel says how many decimals each currency has, and a conversion is by what one unit of each is worth

Status: accepted (request 40)

## Context

Request 40: a group may now be in `JPY` or `KRW`, which have no minor unit, or in `KWD` or `BHD`, which count in thousandths,
beside Tally's six that count in hundredths. Every amount is a whole number of the minor unit of the currency it is in: `1250`
is 12.50 euros, 1250 yen and 1.250 dinars. An amount kept before this change is in one of the six, in hundredths, and reads as
it did. Between two currencies, a rate is what one unit of a currency is worth in the other, and the amount in the group's
currency is the original amount, read in its currency's units, times the rate, written in the group's minor unit, a half
rounded up. A reminder is for more than 20 of the group's currency: 2000 hundredths, 20 yen, 20 000 thousandths.

The storm (`conventions/storms/currency-precision.yaml`) decided the hot spots before the run: the minor unit is in the shared
kernel, a word every context agrees on; the two conversions read it; the reminders' threshold is compared in the group's own
currency, which Settlements already reads and answers in OutstandingDebts; nothing kept is stored converted. No context is new
and no command, query or fact changes. The one relationship the reminders use, Settlements → Notifications (OutstandingDebts),
is carried already.

## Decision

- **The currencies are in the shared kernel.** `SharedKernel/Domain/Currency.ts` holds `CURRENCY_DECIMALS`, the ten codes with
  the decimals of each minor unit (2 for the six, 0 for `JPY` and `KRW`, 3 for `KWD` and `BHD`), and three things every context
  reads the same way: `isCurrencyCode`, `minorUnitsPerUnit` (100, 1 or 1000) and `convertMinorUnits`. Groups' `Currency`, the
  currency lists of the route schemas, Ledger's and Settlements' `OriginalAmount` and the netting's currencies take the list
  from there, so that a currency is added in one place.
- **One conversion, exact.** `convertMinorUnits` multiplies the amount by the rate, read as a whole number of millionths, and by
  the power of ten that moves it from the original's minor unit to the group's (up when the group has more decimals, down when
  it has fewer), and divides by a million and by the power of ten the other way: in integers, so a float never rounds it. The
  result is rounded to the nearest whole number, a half up. Between two currencies of the same decimals this is the amount times
  the rate, as before.
- **Each context asks with the group's currency.** Ledger's `OriginalAmount.amountInGroupCurrency(groupCurrency)` and
  Settlements' `OriginalAmount.amountInGroupCurrency(groupCurrency)` and `convert(amount, groupCurrency)` take the group's
  currency, which the command has already read through GroupCurrency (ADR 8, ADR 14). The provider's fee is in the payment's minor
  unit, so it is converted by the same rate: a settlement's `PaymentProposal` carries the group's currency, and `keepPayment`
  converts the fee with it.
- **The limits are the same numbers.** An amount is from 1 to 100 000 000 of its currency's minor unit, as before, and the
  converted amount in the group's currency is checked the same way. The netting is made in any of the ten currencies.
- **The reminders' threshold is in the group's currency.** `OutstandingDebt` (Notifications' port, ADR 12) and `MemberDebt`
  (Settlements' port) carry the group's `currency`: a new field on an existing contract, answered by Settlements through the
  GroupCurrency port it already has, with no new relationship. Notifications computes the threshold as 20 units of that
  currency in its minor unit (`debtThresholdOf`). `DebtWatch.create`, `DebtWatch.observe` and `Notice.createReminder` take the
  `threshold` the sweep gives them, so the domain compares a debt with a number and reads no currency. A member noted but not
  owing anything any more is seen at 0 under a threshold of 0: owing nothing is under every threshold.
- **Nothing is stored converted.** Every amount kept is in the minor unit of its currency, and an earlier amount was in hundredths
  of one of the six, which is the minor unit it is still in. No amount is rewritten. The one schema change widens the CHECK on a
  settlement's `original_currency` to the ten, as the earlier versions' CHECKs were widened (a `DO` block that does nothing on a
  database that already holds the ten).

## Consequences

- The shared kernel changes, which is an architecture change: this decision records it, and the gate holds the change to it
  (`--mode architecture`).
- Nothing read before this change changes: an expense, a share, a balance, a settlement, a budget, a notice, an audit entry or a
  statement in one of the six currencies is the same integer and is converted the same way.
- A conversion into a currency of fewer decimals rounds to a whole unit of that currency, so an amount of euros in a yen group can
  lose its cents by the same half-up rule every amount already follows. That is the product's rule, not a loss in the stored data.
- The reminders' threshold for a group now depends on the group's currency; a group in yen is reminded at 21 yen, where a group in
  euros is reminded at 2001 hundredths. Both are the same rule: more than 20 of the group's currency.

## When to revisit

When a currency with another number of decimals is added (the table is the one place to add it), when the rates service is asked
for a rate in a currency it does not quote (that is a rates decision, not a precision one), or when an amount must be kept in the
currency of its original rather than the group's minor unit (a new decision, with its own storm).
