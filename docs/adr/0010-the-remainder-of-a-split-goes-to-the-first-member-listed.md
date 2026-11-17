# 10. The remainder of an equal or shares split goes to the first member listed

## Context

Request 10 changes who takes the odd cent. Until now a split by equal parts or by shares gave the whole remainder to the payer
(ADR 0004, ADR 0007). Members found it unfair that whoever pays always takes it. The storm
(`conventions/storms/remainder-to-the-first.yaml`) decided that the change lands in the split value alone, and that earlier
expenses are not computed again: their shares are kept as they were given.

## Decision

- **The remainder goes whole to the member listed first in the split**, whoever paid. An equal split of `1000` between three
  members, the payer listed second, is `334` for the first member and `333` for the payer and for the third. A split by shares
  of `1001` by shares of 2 and 1, the payer listed second, is `668` and `333`.
- **The rule is in `Split`, and nowhere else.** `weighted()` gives the remainder to the first part, which `Split.of()` takes in
  the order the split was given. The payer is still checked to be one of the members of the split (`PayerNotInSplit`).
- **Exact splits have no remainder** and do not change.
- **Earlier expenses are not computed again.** Their shares are stored with each expense (ADR 0007), and `fromSnapshot()` reads
  them as they are. An expense edited from now on (ADR 0006) is split again by the rule in force.

## Consequences

- No command, fact, read model, route or store changes; the expense's shares are the only values the rule decides.
- Balances of expenses recorded before this change do not move. Only a new record or an edit can give a different split.
- The API fragments are unchanged: a split's shares keep their form, and the request says no route changes.

## Alternatives

- **Recompute every stored expense.** Would move money already recorded, and the storm said no. Not taken.
- **Keep the payer's remainder and add an option to choose.** It adds a setting the product did not ask for. Not taken.

## When to revisit

When the split may use a rule other than the first member listed, the rule is decided again here, by an ADR, and the expenses
already recorded keep their shares as before.
