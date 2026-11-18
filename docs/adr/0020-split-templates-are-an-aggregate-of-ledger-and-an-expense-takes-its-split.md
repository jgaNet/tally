# 20. Split templates are an aggregate of Ledger, and an expense takes the split of a template as if it had been given

## Context

Request 25 of Tally (a member saves a split under a name, and an expense recorded or edited may be split by it in place of its own) was
stormed before the code (`conventions/storms/split-templates.yaml`, decided with the product's owner). The storm puts the template in
Ledger, as an aggregate of its own (`SplitTemplate`), and the expense split by it through the link Ledger already has with Groups
(`GroupMembers`, an owned port).

No context and no relationship are new: the map (`conventions/domain.yaml`) already declares Groups → Ledger and its mechanism. The Lite
profile's `several-writers` trigger fires (the saver and the owner replace or remove a template that other members may read), so the
aggregate comes in by this ADR, as in ADRs 18 and 19.

## Decision

- **A `SplitTemplate` is an aggregate of Ledger**, one per name in its group, whatever the case (`src/Contexts/Ledger/Domain/SplitTemplate/SplitTemplate.ts`).
  It holds its group, its name, who saved it, how it splits (`equal` for `splitBetween`, `shares` for `splitByShares`, in the order given) and
  the version it was loaded at. `create` records `TemplateSaved`, `replace` records `TemplateReplaced`, `remove` records `TemplateRemoved`.
- **The template's rules are the save's**, decided by the aggregate and given the facts it needs: the group's members (read through
  `IGroupMembers`) and the id of the template holding the name, if any (`ISplitTemplateStore.nameHeldBy`, a fact about the collection). A
  name is 1 to 60 characters and not only spaces; each member of the split is a member of the group, listed once, with at least 1 share. An
  exact split is not a template: it depends on an expense's amount.
- **Who changes a template** is the use case's, as for an expense or a budget: a caller who is not a member of the group gets `404`, the
  member who saved it or the group's owner may replace or remove it, any other member gets `403`.
- **An expense takes a template's split as if it had been given.** The expense use cases (`RecordExpense`, `EditExpense`) take either a split
  of their own or `template`, the id of a template of the expense's group (`404` otherwise). The template's split is read as a split draft and
  decided by the expense under its own rules, so the members must be the group's at that moment and the payer among them (`422`, as for any
  split). The expense keeps the shares it decided, never a reference to the template: changing or removing a template changes no expense.
- **The storm's hot spots stand as decided**: the template is not part of the expense; the expense checks the members, reading `GroupMembers`
  when it decides; a template whose member has left is kept, and splits nothing (the expense is refused).
- **Persistence**: `split_templates` (one row per template, its name's key unique per group, its version) and `split_template_members` (its
  split by position), in `SqliteSplitTemplateStore`. `save` and `remove` are only written at the version they were loaded at (ADR 8); a second
  writer that took the name first is a conflict, answered `409` after the command's retries.
- **Reading**: `GET /v1/groups/{id}/templates` lists the group's templates, the earliest saved first, each with its split as it was given.

## Consequences

- No new context, no new integration event, and no change to the published language or the map: the events are domain events that nothing reacts to.
- `api/25-split-templates.yaml` is the fragment the routes answer; the expense routes gain `template` as a fourth split key, exactly one of four.
- The storm `conventions/storms/split-templates.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
