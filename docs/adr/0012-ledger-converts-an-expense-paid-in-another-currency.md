# 12. Ledger converts an expense paid in another currency, at the rate its payer states (the Groups → Ledger link, carried)

## Context

Request 21 lets a payer record what they paid in another currency than the group's (francs, for a week in Zurich, in a
group that counts in euros), at the rate they state. The expense keeps the currency, the original amount and the rate, and
the amount in the group's currency is what is split, what exact amounts add up to, and what the balances, the lists and the
statements count. The storm `another-currency` decided three hot spots with the product's owner: where the conversion
lives, how Ledger learns the group's currency, and whether a rate is a number or a string.

## Decision

- **The conversion lives in a value of the expense.** `OriginalAmount` (`Ledger/Domain/Expense`) holds the currency, the
  amount in its hundredths and the rate, kept as the decimal string the payer gave. It computes the amount in the group's
  currency as the original amount times the rate, a half rounded up, in exact integer arithmetic: the rate is read as a
  count of millionths (BigInt), never as a float. Its refusals are named (`InvalidOriginalCurrency`, `InvalidOriginalAmount`,
  `InvalidRate`); the group's amount it gives is checked as any amount is (`InvalidAmount`). The split divides that amount,
  unchanged (requests 4, 7 and 10).
- **Ledger learns the group's currency through a port it owns.** `IGroupCurrency` (`Ledger/Domain/Expense/Ports`), beside
  `IGroupMembers`, answers the currency of a group when the asker is one of its current members, and null otherwise, as if
  the group did not exist. Its adapter `GroupsCurrency` answers it over Groups' read model `findGroupOf`. The currency never
  changes, so a copy in Ledger would have done too; the port adds no fact to keep, and it is the relationship the context map
  already has (Groups → Ledger, owned-port), so the link gains one contract and no new one.
- **A rate is a string.** The body carries the rate as a string, and the value refuses a rate that is not a decimal of at
  most 6 digits after the point, or not greater than 0, by name. Two trees that parse a JSON number into a float would
  disagree on a half; a string read back is the same string. The transport checks only the shape (a string), not the value.
- **An amount is given one way.** A body has exactly one of `amount` (in the group's currency) or `original`; the transport
  refuses a body with neither or with both as the wrong shape (400), as it does for the splits. An edit gives the expense
  whole, as an edit always does: in the group's currency, or in another currency at its rate.
- **Expenses recorded before keep their reading.** The three columns (`original_currency`, `original_amount`, `original_rate`)
  are added to the expenses table and are NULL for an expense in the group's currency, so an expense without `original` reads
  as it did. Integration events are unchanged: ExpenseRecorded carries the amount in the group's currency, which is what
  Notifications counts.

## Consequences

- The context map's Groups → Ledger relationship now carries `GroupCurrency` as well as `GroupMembers`; `yarn check:conventions`
  holds the code to it (CTX-MAP-DECLARED), and the storm `another-currency` is done.
- No new context and no new relationship; Ledger's wiring imports the same Groups export (`groupQueries`) it already imports.
- The rounding is one rule in one place: the balances, the statements and the suggestions read the group's amount, so they
  agree with the expense by construction.

## When to revisit

When a group may change its currency (the rate then is one of a currency that the group no longer counts in, and the
port would need the currency at the time of the expense), or when an expense needs a rate looked up rather than stated.
