# 16. Ledger keeps a split template as its own aggregate, and an expense is split by the template's split, not a reference to it (no new context, no new relationship)

## Context

Request 25 has a member save a split under a name (`Flat`: two shares each for Ann and Bob, one for Cy), and an expense recorded or edited
split by it in place of its own split, under the same rules. The storm `split-templates` decided the hot spots with the product's owner:
a template is not part of an expense, and the expense checks the template's members as it checks any split. This ADR records what the
storm left to the code. Templates live in Ledger, where splits are decided; Groups already answers Ledger the members of a group through
the owned port `GroupMembers` (carried since request 4), which this feature uses and does not change.

## Decision

- **A template is an aggregate of Ledger** (`SplitTemplate`), beside `Expense`, `RecurringExpense` and `Budget`. It holds its group, its name,
  its split as it was given (equally between members, or by whole shares; never by exact amounts, which depend on an amount), who saved it,
  and its version. Its name is 1 to 60 characters, not only spaces, and is free in its group whatever its case: the repository answers the
  fact (`findByName`, on the name in lower case), the aggregate refuses the clash, and a UNIQUE key on the group and that name holds it
  against a race.
- **Its members are checked when it is saved or replaced**, against the group's members, each listed once, each with at least one share. A
  template whose member has since left is kept and splits nothing: the expense that names it is refused by the expense's own rule.
- **Who may change it.** The member who saved it, or the group's owner, replaces or removes it; any other member is refused as not allowed
  (403). A removed template is erased; the events it recorded are published with the commit.
- **An expense is split by the template's split, as if it had been given.** The record and edit commands carry `template` in place of their
  split. `splitOfExpense` (Application) resolves it to the split the template keeps, in the expense's group, and the expense decides it as it
  decides any split (`Split.decide`), with the group's members and the payer among them. An expense keeps its shares and its `splitKind` as
  decided, and no reference to the template: a template changed or removed later changes no expense.
- **No integration event.** Templates are read and changed by the member's own requests; nothing outside Ledger needs to know of them, so the
  three events (TemplateSaved, TemplateReplaced, TemplateRemoved) are domain events, published in the transaction and handled by no one.

## Consequences

- No new context and no new relationship. The Groups → Ledger link carries `GroupMembers` as before, and `conventions/` is unchanged apart
  from the storm's `done` flag and the term in `domain.yaml`.
- The name check is made by the repository and the aggregate together, as the budget's category is; the UNIQUE key is the backstop for two
  writers at once, which answers the same named refusal.
- Command names that the repository shares with aggregate behaviours (`save`, `delete`) are avoided: the architecture check reads a handler's
  calls by name, so the aggregate's behaviours are `draft`, `replace` and `remove`, and the repository's delete is `erase`.

## When to revisit

When a template must be split by its members as they were when it was saved, rather than the group's members now (then the template keeps
the membership it was saved with, and Groups must answer it); or when templates are shared across groups.
