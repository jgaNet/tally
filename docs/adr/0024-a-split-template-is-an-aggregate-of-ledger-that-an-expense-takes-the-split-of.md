# 24. A split template is an aggregate of Ledger, and an expense takes the split of the template it names

## Context

Request 25: a member saves a split under a name (a template: between some members equally, or by whole shares), and an expense recorded or
edited may name one of its group's templates in place of a split. The expense is split as if that split had been given, under the same
rules; it keeps its shares, and a template changed or removed later changes no expense. The storm
(`conventions/storms/split-templates.yaml`) decided before any code: a `SplitTemplate` aggregate of Ledger, whose name is free in its group;
the expense is given the template's split, and never holds a reference to the template; the members are checked by the expense, as for any
split, against Groups' members (the link Groups → Ledger, GroupMembers, which ADR 0004 already carries).

The storm adds no context and no relationship between contexts, and no integration event: the templates' events are facts nothing reacts to.

## Decision

- **A `SplitTemplate` is an aggregate of Ledger** (`Domain/SplitTemplate`), one per template, identified by a generated id. `create()` validates
  the name (1 to 60 characters once trimmed, not only spaces), the split (between one or more of the group's current members, each listed once,
  each with at least 1 share; a split by exact amounts is not a template), and that the name is free in the group, and records
  `TemplateSaved`. `replace()` and `delete()` are for the member who saved the template and the group's owner only; any other member is refused
  with `403`, and each records `TemplateReplaced` or `TemplateRemoved`. The version is the one it was read at, checked by its store.
- **The name is unique by a fact of the store, not by the aggregate alone.** `ISplitTemplates.findByName(groupId, name)` answers the template of
  the group with the same name, ignoring case and surrounding spaces (`templateNameKey`); the use case gives the aggregate `nameIsFree`, which
  the aggregate checks as a rule. The table keeps the same key in a unique index as a backstop. A taken name is `409` (`TemplateNameTaken`, an
  `AlreadyExists`, since a thing of that name already exists).
- **An expense takes the template's split in its use case.** `splitGiven()` (`Application/SplitTemplates.ts`) reads the template the body names:
  it must be one of the expense's group, else `404`. Its split is then given to `Expense.register()` or `edit()` exactly as a split in the body
  would be, so the Expense checks the members and the payer against the group at that moment (`Split.of`), and an equal split keeps the
  remainder to the first member listed (request 10). The expense stores its own shares and kind; nothing of the template is kept with it.
- **The transport says exactly one of the splits and `template`.** An expense's body is `oneOf` the three splits and `template`; a template's
  body is `oneOf` its two shapes, `splitBetween` or `splitByShares`. Neither or both is `400`; whether the members or the shares are allowed is
  the domain's (`422`).
- **The API is request 25's** (`api/25-split-templates.yaml`): `POST /groups/{id}/templates` answers `201 { id }`, `GET` lists the group's templates
  earliest first (the store's row order), `PUT /templates/{id}` and `DELETE` answer `204`. A non-member is `404`, as if the group did not exist.
- **Lite admits it without a new trigger.** Ledger already holds its aggregates and domain events (the triggers `several-writers` and
  `reacts-to-domain-event` fire there, ADR 0004, ADR 0023), so the template aggregate needs no new record in the profile.
- **Method names are the storm checker's test.** The conventions check reads a use case's aggregate from the behaviours its text calls, by method
  name, on any receiver. `register` and `remove` are already behaviours of `Expense`, so a template's `register()` and `remove()` were read as the
  expense's, and the storm was not met. The template's creation is `create()`, its removal `delete()` (and the store's `delete()`), so each
  command reads as the template's own. The convention allows either name for a creation (`create()` / `register()`).

## Consequences

- A new table, `split_templates`, in the application's file. Its rows are removed when a template is; the expenses it split keep their shares.
- The expense's storage is unchanged: no column, no reference to a template.
- Two new domain events and one more aggregate in Ledger; no integration event, so `conventions/integration-events.yaml` is unchanged.
- A member who has left the group is still named by the templates that have them. The templates keep them and split nothing: an expense
  split by such a template is refused as any split of a former member is (`422`), until the template is replaced.

## When to revisit

When an expense must say which template it was split by (a reference the request does not ask for and a template's removal would then have to
answer), when a template must be shared across groups, or when a member's leaving must replace it in every template they are named by (the
request says a template is kept).
