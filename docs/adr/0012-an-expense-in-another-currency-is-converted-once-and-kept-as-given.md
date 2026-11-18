# 12. An expense in another currency is converted once, in exact arithmetic, and kept as given

## Context

Request 21 lets an expense be paid in another currency than its group's: the payer states the currency, the amount in its
hundredths and the rate, what one unit of that currency is worth in the group's currency. The amount in the group's currency
is what is split (requests 4, 7, 10), what the balances, the lists and the statements count, and what a notice gives. The
storm for the feature (`conventions/storms/another-currency.yaml`) decided where the conversion lives, how Ledger learns the
group's currency, and that a rate is a string.

The storm declared one contract the Groups → Ledger link did not carry: `GroupCurrency`, beside `GroupMembers`. Groups already
keeps the currency (request 2) and answers it on its read model (`currencyOf`), so the link needed only a port Ledger owns.

Two facts shape the decision. The currency list (request 2) is a published fact about money that Ledger must check a payer's
currency against, and Ledger may not import Groups' Domain (ARCH-INWARD). And a rate multiplied in floating point is not exact:
`1000 × 0.9545` and a half in general would round differently on two trees that parse a number differently.

## Decision

- **The conversion lives in the expense.** An `OriginalAmount` value object (`Ledger/Domain/Expense`) holds what was paid: a
  currency of Tally's other than the group's, an amount in its hundredths (1 to 100 000 000), and the rate, kept as the string
  given. It computes the amount in the group's currency: the amount times the rate, rounded to the nearest whole number, a half
  rounded up, in `BigInt` arithmetic over the rate scaled by 10^6. The result is then an `Amount` like any other: an amount out
  of 1 to 100 000 000 is refused by the expense (`InvalidAmount`). The `Split` divides that amount unchanged.
- **The expense keeps both.** `Expense` holds `original` (`null` for an expense in the group's currency) beside its `amount`. A
  body gives exactly one of `amount` and `original`; the domain takes the same choice as a `MoneyInput`, so it does not trust the
  transport for it. Recording and editing both decide money through the one rule (`Expense.decide`), so the same refusals hold.
- **Ledger reads the group's currency through a port it owns, `GroupCurrency`** (`IGroupCurrency`, `Ledger/Domain/Expense/Ports`),
  answered by `GroupCurrencyFromGroups` over Groups' read model (`currencyOf`), read when the command decides, beside the membership
  port. The adapter is a function over Groups' read model, read when asked, for the same reason as the membership adapter (ADR 4).
  The context map's link Groups → Ledger carries it; it is not a new link.
- **The currency list is in the shared kernel** (`SharedKernel/Domain/Currency.ts`): the six currencies of request 2 are the one
  published fact about money every context agrees on, and Ledger checks the payer's currency against it without importing Groups.
  Groups' `Currency` re-exports the list and keeps its own value object; the list has one definition.
- **A rate is a string, and its validity is the value's.** The transport checks only that `rate` is a string (a number is of the
  wrong shape: 400). The form (a decimal number with at most 6 digits after the point) and that it is above 0 are refused by the
  value, as `InvalidRate`, by name. So are an unknown currency (`InvalidOriginalCurrency`), the group's own currency
  (`SameCurrencyAsTheGroup`) and an amount out of range (`InvalidOriginalAmount`).
- **Stored as given.** Three nullable columns on `expenses` (`original_currency`, `original_amount`, `original_rate`), added on start
  as the other columns were. A file made before has NULL, which is an expense in the group's currency. The read model gives
  `original` only when there is one, so an expense in the group's currency reads as before.

## Consequences

- An expense in another currency is counted in the group's currency everywhere it was counted before: the balances, the lists,
  the statements, the notices and the settlements see only `amount`. Nothing downstream learns a second currency.
- The group's currency never changes (request 2), so the port's answer is stable within a command; the read is in the command's
  transaction, and it needs no lock of its own.
- The conversion is decided once, at the moment the expense is recorded or edited. A later change of rate is an edit, which is
  refused for a former member as any edit is (request 9).
- An edit to an expense in the group's currency with the same numbers and no `original` keeps `original` absent, and an edit to
  `original` replaces it whole.

## When to revisit

If a rate should be fetched from a source (a rates feed, a date), that is a port the domain asks, and a new decision: the rate is
still the payer's, given, in this request. If the group's currency could change, the port's answer would need a version, and the
converted amounts of existing expenses would need a decision of their own; neither is in request 21.
