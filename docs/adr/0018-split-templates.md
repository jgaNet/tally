# 18. Split templates: an aggregate in Ledger, and an expense is split by one as if its split had been given

## Context

Request 25: a member saves a split under a name (two shares each for Ann and Bob, one for Cy), and an expense recorded or edited
may give the template's id in place of its own split. The expense is then split as if the template's split had been given, under
the same rules, and keeps its shares as decided: a template changed or removed later changes no expense. The storm
(`conventions/storms/split-templates.yaml`) decided the hot spots before the run: the template is an aggregate of its own in Ledger
(SplitTemplate), not a part of an expense; the expense checks the template's members when it decides, reading GroupMembers as it does
for any split; a template whose member has left is kept and splits nothing.

## Decision

- **No new context and no new relationship.** The template lives in Ledger beside the expenses (`Domain/SplitTemplate`), and Ledger
  already asks Groups who is a member (GroupMembers, ADR 3). The storm names that existing link and no other, so the conventions' context
  map is not changed.
- **The expense takes the split, and refers to nothing.** `splitOfExpense` turns the template into the split it was saved with, as if the
  body had given it, and `Split` decides it under the rules of recording. The expense stores its shares and how it was split (`equal` or
  `shares`) as it always did; no column or event carries the template's id. Giving a template together with a split of its own is
  refused (OneSplitOnly); a template of another group is not found.
- **A template is either equal or by shares.** An equal split between members is stored as the shares of 1 each, which is how `Split`
  already divides an equal split, so one form holds both kinds and the read model returns what was given (`splitBetween` or
  `splitByShares`). Exact amounts are not a template's, since they depend on an expense's amount.
- **The name is free in the group, whatever its case.** The domain decides it: the handler reads the template of the group that has the
  name's key (`findByName`), and the aggregate refuses a name another template holds (TemplateNameTaken). The table's
  `UNIQUE (group_id, name_key)` is only a backstop for two saves racing; the repository answers the same refusal for it.
- **Members are checked when the template is saved or replaced**, against the group's members then (NotAGroupMember). They are not
  re-checked when it is read, and a member who leaves afterwards does not remove the template; an expense that uses it is refused by
  the expense's own check, as any split is.
- **Who may change it.** The member who saved it, or the group's owner: the aggregate decides (`byOwner`, the saver's id). A non-member
  does not see the template (not found), and any other member is refused (NotAllowedToChangeTemplate) in the operation's error.
- **The order of the list is the order of the first save.** Replacing a template keeps its place; the list reads the rows by rowid.
- **Removal deletes the row.** The aggregate answers a removed instance and the repository forgets it; the expenses that were split by it
  are not touched.
- **The operations are named for the storm's checker.** The checker matches a handler's `.name(` calls against every aggregate's
  operations, so the template's are `draft`, `revise` and `retire`, and its value object is built by `TemplateName.of` (not `create`),
  for the reason ADR 17 gives. A handler that called a same-named operation of another aggregate would be recorded against it.

## Consequences

- Two tables, `ledger_split_templates` and `ledger_split_template_members`, created with `CREATE … IF NOT EXISTS` as the others are.
- An expense's split is computed from the template at the moment it is recorded or edited; an expense recorded before the feature is not
  changed, as it has no template.
- The events TemplateSaved, TemplateReplaced and TemplateRemoved are recorded on the aggregate and published after the commit, as every
  domain event is (EVENT-AFTER-COMMIT); nothing subscribes to them yet.

## When to revisit

When templates should be shared between groups, when a template should be dropped or flagged once one of its members leaves, or when an
expense in another currency should be split by a template with its amount converted first (the template's shares are of the amount in the
group's currency, as any split is, so this needs no change of the split itself).
