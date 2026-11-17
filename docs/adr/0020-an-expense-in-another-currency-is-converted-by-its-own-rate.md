# 20. An expense in another currency is converted by the rate its payer states, and Ledger asks the group's currency through a port

## Context

Request 21: the week in Zurich was paid in francs, and the group counts in euros. The payer says what they paid, in which currency and
at what rate. The expense keeps its currency, its amount in that currency, and its rate as given; its amount in the group's currency is
the original times the rate, rounded to the nearest whole number, a half up, and that amount is what is split, what the balances, the
lists and the statements count. An edit gives the expense whole again, so it is in the group's currency or in the other one at its rate.

The storm (`conventions/storms/another-currency.yaml`) decided three things before any code: the conversion is a value of the Expense
(`OriginalAmount`), the group's currency reaches Ledger through a port it owns on the relationship it already has with Groups, and the
rate is a string, not a number. The storm adds no sticky and no new context: it changes the relationship Groups → Ledger, which already
carries `GroupMembers`, so that it now also carries `GroupCurrency`.

## Decision

- **The conversion is `OriginalAmount`, a value of the Expense.** `create(input, groupCurrency)` refuses a currency that is not one of
  Tally's (`UnknownCurrency`), the group's own currency (`OriginalCurrencyIsGroupCurrency`), an amount that is not 1 to 100 000 000 in
  its hundredths (`InvalidOriginalAmount`), a rate that is not a decimal of at most 6 digits after the point (`InvalidRate`), and a rate
  that is 0 (`NonPositiveRate`). `toGroupAmount()` multiplies the amount by the rate in millionths, as integers (BigInt), and rounds half
  up: `1234` at `"1.0625"` is `1311`, and `1000` at `"0.9545"` is `955`. The expense's amount is that, and the Expense refuses it by the
  rule it already has (`InvalidAmount`) when it is not 1 to 100 000 000. The Split divides that amount unchanged.
- **The group's currency is a port Ledger owns, `IGroupCurrency`.** `currencyOf(callerId, groupId)` answers the currency of a group the
  caller is a member of, and `undefined` otherwise, as if the group did not exist. Groups answers it through `GroupCurrencyOfGroups`, in
  Ledger's Infrastructure, over Groups' read model (`IGroupQueries.findGroupOf`), wired beside `GroupMembersOfGroups` in Ledger's wiring.
  The use cases ask it only for an expense given in another currency, and pass the currency to the Expense, which decides with it.
  The currency never changes, so a copy would have done as well, but a port adds no fact to keep.
- **The list of currencies is in the shared kernel.** Tally's currencies (`CURRENCIES`, request 2) move to `SharedKernel/Domain/Currency.ts`,
  because Ledger may not import Groups' domain and must check "one of Tally's currencies" itself. Groups' `Currency` reads the same list.
- **The rate is kept as the string given.** The expense stores it, reads it back as given (`"12.5"`, not `12.5`), and the store never parses it
  into a float: two readers parsing a JSON number could disagree on a half. Its 6-digit rule is the value's, refused by name, not the body's
  shape: the transport checks that `rate` is a string (API-BODY-SHAPE).
- **The original is kept on the row.** Three nullable columns (`original_currency`, `original_amount`, `original_rate`), added to an existing
  file when it is opened (as `split_kind` was, request 7). An expense in the group's currency, and every expense recorded before this request,
  has none. The read models give `original` only when there is one.
- **The transport gives exactly one of the two amounts.** A body with `amount` and one with `original` are the two shapes; a body with neither,
  or both, answers `400`. The split is still exactly one of three (request 7). The values are the domain's to refuse, as before.

## Consequences

- The relationship Groups → Ledger now carries `GroupCurrency` as well as `GroupMembers`. The context map (`conventions/domain.yaml`) states
  it in the relationship's words; no new relationship and no new context. The storm check reads the link from the code.
- A rate or amount refused is an operation's `ERROR` behind the `202`, named by its rule, as every expense refusal is (requests 4, 6, 7).
- The balances, the statements, the suggested settlements and the notices are unchanged: they count the amount in the group's currency, which
  is what an expense has always been. The integration event `ExpenseRecorded` announces that amount and is not changed.
- A later request that converts a balance, or changes the rate of a recorded expense, is a new decision: the rate is kept as given, and an
  edit gives it again.

## When to revisit

When the group's currency can change (then the port's answer is no longer a constant and the conversion of an expense recorded before must be
decided); and when a rate must come from a source of its own, not the payer (then the rate is a port Ledger owns, answered by an adapter).
