# 18. An expense in another currency: the group's currency is a port Ledger owns, and the currencies are the shared kernel's

## Context

Request 21 lets an expense be paid in another currency, at a rate its payer states. The expense keeps what was paid, the rate
and both amounts, and it is counted and split in the group's currency: the amount is the original times the rate, rounded to the
nearest whole number, a half up. Two facts are needed that Ledger does not hold:

- the group's currency, which Groups fixes when it creates the group (request 2): an expense in the group's own currency is not
  "another currency", so Ledger must know it to refuse one;
- the list of Tally's currencies, which a group is in and an expense may be paid in: both Groups and Ledger need it.

The storm (`conventions/storms/another-currency.yaml`) decided the design before the code. It puts the conversion in a value of the
expense, and it brings one change to the context map that the map did not declare: the relationship Groups → Ledger carries one
more contract, `GroupCurrency`, beside `GroupMembers`.

## Decision

- **Ledger asks the group's currency through a port it owns, `IGroupCurrency`** (`currencyOf(groupId, askedBy)`), in its own words, as
  it asks the members (ADR 5). It is answered by `GroupCurrencyOfGroups` over Groups' read model, through `groupOf`, which the
  read model already offers: no new query on Groups. Asked by a member; to anyone else the group does not exist. The currency is
  fixed at creation, so an expense recorded in a group never sees a different one.
- **The currencies move to the shared kernel.** `CURRENCIES`, `CurrencyCode` and `isCurrencyCode` are in
  `SharedKernel/Domain/Currency.ts`, which Groups' `Currency` value object and Ledger's `OriginalAmount` both import. Neither context
  imports the other to know the list (ARCH-TREES: the shared kernel imports no context).
- **The conversion is a value of the expense.** `OriginalAmount` holds the currency, the amount in its hundredths (1 to 100 000 000)
  and the rate as the string given. Its amount in the group's currency is computed in exact integer arithmetic, the rate held in
  millionths: `floor((2 * amount * rate + 10^6) / (2 * 10^6))`, a half rounded up, never in floating point. The expense checks that
  amount like any other (1 to 100 000 000), and its split divides it unchanged.
- **The rate is checked by name, not by shape.** The body gives a rate as a string (its shape, `400`); whether it is a decimal number
  greater than 0 with at most 6 digits after the point is the value's, refused as `InvalidExpenseRate`.
- **The map is declared, not planned.** The relationship Groups → Ledger (owned port) gains `GroupCurrency` in
  `conventions/domain.yaml`; the check reads the contract from the code, where `IGroupCurrency` is the port Ledger owns and its
  adapter reads Groups' read model.

## Consequences

- `ExpenseRecorded` keeps its `amount`, in the group's currency, so Notifications and the balances are unchanged.
- The storage gains three nullable columns on `ledger_expenses` (`original_currency`, `original_amount`, `original_rate`), added once
  by the migration; every expense a file holds before it has none, and it is in the group's currency, as it was.
- A refused amount, currency or rate is a `400` naming its rule, as any refused value of a recording or an edit.
- Changing the list of currencies changes Groups and Ledger together, in the one shared file.

## When to revisit

If a group may change its currency, the expense must keep the currency it was counted in and the port's answer must be read at the
moment of the decision only (it is now). If the rate is to come from a provider rather than from the payer, the rate becomes a port
whose answer is a plain value the expense validates (DOMAIN-NON-DETERMINISM), and this record is superseded.
