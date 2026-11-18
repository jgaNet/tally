# 22. Split templates: an aggregate of Ledger, and an expense takes the template's split, not a reference to it

## Context

Request 25 lets a member save a split under a name (`api/25-split-templates.yaml`): a name of 1 to 60 characters, unique in the group
whatever its case, and either a split equally between members or one by shares, its members members of the group, each listed once, each
with at least 1 share. An expense recorded or edited may give `template`, the id of one of its group's templates, in place of its own split,
and is then split as if the template's split had been given, under the same rules, by the rule in force. An expense keeps its shares as
they were decided, and a template changed or removed later changes no expense. A member lists the templates, the earliest saved first; the
member who saved a template, or the group's owner, replaces or removes it.

The storm (`conventions/storms/split-templates.yaml`) was decided before the code: `SplitTemplate` is an aggregate of Ledger of its own, its
name free in the group; the expense is given the template's split as if its body had given it, never a reference to the template; a template
whose member has left is kept and splits nothing, and the expense checks its members as it does for any split.

No new context and no new relationship: templates are Ledger's, and the members of a group are already read through `GroupMembers` (ADR 5).

## Decision

- **`SplitTemplate` is an aggregate of Ledger**, in `Domain/SplitTemplate`: `create()` generates its id and records `TemplateSaved`;
  `replace()` keeps the member who saved it and records `TemplateReplaced`; `remove()` records `TemplateRemoved`. Its split is one of the two
  ways a split is asked that a template can take (`TemplateSplit`: equal, or by shares). A split by exact amounts makes no template, since its
  amounts depend on an expense's amount: the body that gives one is refused by shape (400).
- **The rules are pure decisions** (`SplitTemplate.decision.ts`): `decideSaveTemplate`, `decideReplaceTemplate` and `decideRemoveTemplate`.
  The name is checked first (`TemplateName`: trimmed, 1 to 60 characters), then the split (members of the group, each once, at least one, shares at
  least 1), then whether another template of the group has the name. A replacement or a removal is allowed to the member who saved the template
  and to the group's owner only, and any other member is refused before the values are looked at.
- **Uniqueness is a fact the store answers.** `isNameTaken(groupId, name, exceptId)` compares the name's key, trimmed and in lower case, and the
  store holds the key with a unique constraint on the group and the key as a backstop. The domain decides; the store only says whether a name is
  taken.
- **An expense takes the template's split when it is decided, and keeps only its shares.** `SplitChoice` is the expense's input: exactly one of
  the three splits (request 7) or `template`, the id of a template. The use case reads the template in the same transaction as the expense, refuses
  a template that is not one of its group's as not found (404), and hands the template's split to the existing expense decision unchanged. Nothing
  in `Expense` refers to a template, so a change or removal of a template changes no expense (the storm's decision), and a template whose member has
  left refuses the expense by the rule that refuses any split of a former member (`SplitMemberNotInGroup`, 400).
- **Order.** Templates are read in the order they were saved: `ORDER BY rowid`, which only grows for a row that is inserted and is kept by an update.
- **Routes.** `POST /groups/{id}/templates` (201 `{ id }`), `GET /groups/{id}/templates`, `PUT /templates/{id}`, `DELETE /templates/{id}`, all answered at
  once through `answerAtOnce()`; an expense's body takes `template` in place of its split, on the recording and on the edit.

## Consequences

- The store holds the templates in the same SQLite file as the expenses (ADR 5, ADR 17), in two tables of their own; no existing table changed.
- The template is read at the expense's decision and not again: an expense recorded from a template is the same whatever the template becomes later.
- The uniqueness of a name rests on the check in the same transaction as the write, and on the unique key in the file. Two servers writing one file at
  once are serialized by the file's transactions (ADR 17).
- The outbox is still the process's in-memory one (ADR 14, ADR 20): the three template events have no subscriber, so none is lost to a relay gap
  today; a subscriber added later inherits the gap ADR 21 records.

## When to revisit

When a template should be shared between groups (it is a group's own now, and an expense of another group is refused as not found), or when a template
should refer to the members by name rather than by account, which would change what a template keeps when a member leaves.
