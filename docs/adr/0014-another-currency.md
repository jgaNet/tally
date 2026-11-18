# 14. An expense in another currency: it keeps what was paid and its rate, and Ledger asks Groups for the group's currency

## Context

Request 21 lets a payer record what they paid in another currency than the group's, at the rate they state, so that the
expense counts, and is split, in the group's currency. Until now an expense was in the group's currency only, and every
amount, share and balance was an integer of its hundredths.

The storm (`conventions/storms/another-currency.yaml`) decided three things before the run: where the conversion lives;
how Ledger learns the group's currency, which Groups keeps (request 2); and that a rate is a string, read back as given.
It owes one relationship change: the link `Groups → Ledger` carries `GroupCurrency` beside `GroupMembers`.

## Decision

- **The conversion is a value of the Expense.** `OriginalAmount` (Ledger's `Domain/Expense`) holds the currency, the amount
  in its hundredths and the rate as the string given. `amountInGroupCurrency()` computes the original amount times the
  rate, rounded to the nearest whole number with a half rounded up, in exact decimal arithmetic (the rate scaled to six
  digits, as a `bigint`), never in floating point. Its result is an `Amount`, so it is refused by the same rule as any
  amount: 1 to 100 000 000, otherwise `InvalidAmount`.
- **The expense's `amount` stays the group's.** The Expense keeps the converted amount as its `amount`, and its
  `original` alongside, or `null` for an expense in the group's currency. The split divides the amount unchanged; the
  balances, the lists, the statements, the notices and the events count the amount, as before. No event's payload changes,
  so no integration event gains a version.
- **Ledger asks Groups for the group's currency, through a port it owns** (`IGroupCurrency`, beside `IGroupMembers`).
  Its adapter, `GroupsGroupCurrency`, answers it over Groups' `IGroupCurrency`, read inside the command's transaction
  (`groupCurrencyInCommand`, exported by Groups' wiring as before for Settlements). The port is asked only when an
  expense gives `original`. The currency never changes, so a copy would do too; the port adds no fact to keep.
- **The rate is a string, kept as given.** The body's `rate` is a string at the transport, and the domain refuses by name
  (`InvalidRate`) a rate that is not a decimal number of at most six digits after the point, or that is not greater than
  0. The transport never refuses a value, only a shape (ADR 2, API-BODY-SHAPE). Fastify runs with `coerceTypes` off, so a
  JSON number is a shape refusal, not a string read back differently.
- **Storage**: a side table `ledger_expense_originals` (one row per expense in another currency), written in the
  transaction that saves the expense and removed with it, as `ledger_expense_splits` is: the migrations run at every start,
  so a column cannot be added.
- **The currencies are Tally's six.** Ledger keeps its own list of the codes an expense may be in
  (`OriginalAmount.CURRENCIES`), the list Groups keeps as `Currency.CODES`. A fifth currency is added in both; a context does
  not import another's Domain for it.

## Consequences

- `Groups → Ledger` carries `GroupCurrency` and `GroupMembers`; its `why` in the context map says so.
- An expense in the group's currency is stored and read as before: no `original` key, no new row.
- A refused original currency (the group's own, or one that is not Tally's) is `SameCurrencyAsGroup` or
  `InvalidOriginalCurrency`; a group that does not exist is refused as a non-member, as a split of one is.

## When to revisit

If Tally keeps rates over time (a rate that changes after the expense is recorded), the rate moves from the expense to a
fact of its own; this request keeps the rate the payer stated, once, and never changes it.
