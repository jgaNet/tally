# 16. An expense in another currency keeps its original, and Ledger reads the group's currency through a port it owns

## Context

Request 21 of Tally (`conventions/storms/another-currency.yaml`, decided with the product's owner before the code) lets the payer of
an expense say what was paid in another currency and at what rate. The expense keeps the currency, the original amount and the
rate, and counts, splits and lists the amount in the group's currency, the original times the rate rounded to the nearest whole
number, a half up. The storm brings three things the architecture did not carry yet: Ledger must know the group's currency, which
Groups keeps (request 2); the conversion must be exact; and the rate must be read back as its payer wrote it.

## Decision

- **The relationship Groups → Ledger carries a second port, `GroupCurrency`.** Ledger owns `IGroupCurrency`
  (`Ledger/Application/IGroupCurrency.ts`), in its own words: `currencyOf(groupId)`, the code the group was created in, or
  `undefined` when there is no such group. Its adapter, `GroupCurrencyFromGroups` (`Ledger/Infrastructure/`), is over Groups' roster,
  the same read model `GroupMembersFromGroups` is over; no domain imports Groups. The composition root gives Ledger's wiring one
  more adapter over the database, as it gives it the members. The currency never changes, so reading it when the expense is decided
  is the same as copying it, and a port adds no fact to keep.
- **The conversion lives in a value of the expense.** `OriginalAmount` (`Ledger/Domain/Expense/OriginalAmount.ts`) holds the
  currency, the amount in that currency's hundredths (1 to 100 000 000) and the rate as the string given. Its `decide()` refuses a
  currency that is not one of the six codes, the group's own currency, an amount out of range, or a rate that is not a positive
  decimal with at most six digits after the point, each by its own name (`422`). `toGroupAmount()` computes the amount in the group's
  currency in exact integers: the rate is read as a whole number of millionths, the product is rounded half up with one integer
  division, so `1234` at `"1.0625"` is `1311` and `1000` at `"0.9545"` is `955`. Floating point is never used.
- **The converted amount is the expense's amount.** An expense converts an original to its amount, which is then refused like any
  amount if it is not from 1 to 100 000 000 (`InvalidExpenseAmount`). It is what is split (the `Split` divides it unchanged), what the
  balances and the lists and statements count, and what the expense's `amount` reads as. An expense in the group's currency keeps no
  original, and reads as before.
- **The rate is kept as a string, and the body's shape is only its type.** The transport refuses a body with neither or both of
  `amount` and `original` (`400`), and an `original` whose fields are of the wrong type; the currency, the amount range and the rate's
  value are the domain's, refused with their names. The rate is stored as the string it was given (`expense_originals.rate`), so the
  read gives it back unchanged, and no two readers parse it into a float.
- **The currency list is Ledger's own.** Ledger's domain keeps the six codes of `ORIGINAL_CURRENCIES`, the same codes Groups creates a
  group in (request 2). Ledger cannot import Groups' domain, and a shared list would be a change to the shared kernel, which this
  feature does not make. The list is the one place the two must agree; a seventh currency is added to both, and the API fragment says so.
- **Storage.** `expense_originals` is one row per expense in another currency, written with the expense, replaced on an edit and removed
  with a deletion, in the same transaction. The expenses kept before this change have no row, so they read as they did.

## Consequences

- `conventions/domain.yaml` says the relationship carries the group's currency; the conventions check reads the contracts from the code,
  which now carries `GroupCurrency` and `GroupMembers`.
- An edit gives the expense whole again (request 6): with an `amount` it is in the group's currency, with an `original` it is in that
  currency at that rate.
- Notifications and the balances see only the converted amount, so they are unchanged: `ExpenseRecorded` still announces `amount`, in
  the group's currency.
- The lists and the statements read the original too, since they answer the same `expense` resource (fragment 21).

## When to revisit

When a group may change its currency (the port then needs a change event, not a copy), and when a currency is added: the list in
Ledger and Groups' `Currency` must change together, and the API fragment with them. When rates must be fetched rather than stated, the
rate becomes a port's answer, not the payer's.
