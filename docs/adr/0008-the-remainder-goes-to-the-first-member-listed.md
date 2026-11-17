# 8. The remainder of a split goes to the first member listed

## Context

ADR 5 and ADR 6 gave the remainder of an equal split, and of a split by shares, whole to the payer. Members found it unfair
that whoever paid always took the odd cent. Request 10 (`conventions/storms/remainder-to-the-first.yaml`, decided with the product's owner
before the run) changes the rule: the remainder goes whole to the share of the member listed first in the split, whoever
paid. The shares still add up to the amount exactly, and the payer is still one of the members of the split. Splits by
exact amounts have no remainder and do not change.

No context or relationship is added, and no command, fact or read model changes: the change lands in the `Split` value.

## Decision

- **The remainder goes to the first member listed.** `Split.create` gives the remainder of an equal split, and of a split by
  shares, to the member listed first in the request, whoever paid. For 1000 split equally among three members, the payer
  listed second, the first member has 334 and the payer and the third 333.
- **Earlier expenses are not computed again.** An expense recorded before this change keeps the shares it was given. A
  stored split is restored from its kind and amounts, never divided again; an equal split is accepted when its remainder
  sits with the first member listed (the new rule) or with the payer (the rule before this change), and refused otherwise.
- **An edit splits again, by the new rule.** `EditExpense` makes a new split through `Split.create`, as any edit splits.

## Consequences

- ADR 5's and ADR 6's statement that the remainder goes to the payer describes the splits recorded before this change; from
  now on the remainder goes to the first member listed.
- The API is unchanged: its routes, status codes, and body shapes are the same, and a split answers the same fields. Only
  the values of new and edited splits can differ from before, where the payer was not the first member listed.
- `Split.restore` now accepts an equal split under either rule, which is the price of not computing old expenses again. A
  stored split whose remainder sits with neither rule is still refused as corrupted.

## When to revisit

- When members want the remainder spread rather than given to one member (a rotating member, or one chosen per expense):
  then the choice of who gets it becomes a stored fact of the expense, and the rule's history gets its own decision.
