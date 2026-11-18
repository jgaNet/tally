# 16. A split template is an aggregate of Ledger, and an expense is split by it as if its split had been given

## Context

Request 25 lets a member of a group save a split under a name (equally between members, or by shares), and lets an expense recorded or
edited be split by it in place of its own split. The storm (`conventions/storms/split-templates.yaml`) decided two hot spots: whether a
template is part of an expense, and who checks the template's members.

The storm needs no new context and no new relationship. The members of the group, and whether a caller is the owner, are read from Groups
through `GroupMembers`, the port Ledger already owns (ADR 3); the expenses keep their own shares, as they always did. What changes in the
architecture is nothing: the context map and the published language are as they were.

## Decision

- **A template is an aggregate of Ledger, `SplitTemplate`, of its own.** It is not part of an expense: an expense is never a reference to a
  template. An expense named by a template is given the template's split, as if the command had given it, and keeps the shares that split
  decided, as it always keeps them. A template changed or removed later therefore changes no expense.
- **A template's split is one of the two kinds it can keep**: equally between members, or by shares (`TemplateSplit`, a subset of the
  expense's `SplitInput`). Exact amounts make no template, since they depend on an expense's amount. The transport gives exactly one of the
  two (a body of neither, or of both, is refused as the wrong shape, 400).
- **A template's name is free in its group, whatever its case.** The name is 1 to 60 characters and not only spaces. The uniqueness is a fact
  about the collection, so the repository answers it (`nameTaken`, through the name's key, the name in lower case) and the handler passes the
  answer to the aggregate, which refuses it. This mirrors how the handler reads whether the caller is the owner and the aggregate decides.
- **The template's members are checked when it is saved or replaced**, as request 25 says: each is a current member of the group, listed
  once, with a whole number of shares of at least 1. The storm's answer to "who checks the members" still stands for the expense: a
  template whose member has left is kept, and an expense split by it is refused by the expense's own rules (a member who has left is
  `NotAMemberOfTheGroup`, a payer not in the split is `PayerNotInSplit`), when it decides.
- **An expense names a template in place of a split.** The command carries either a split or a template of the expense's group; the
  handler resolves the template to its split (`resolveSplit`), and a template of another group is not found. The expense decides as it
  always does.
- **Who may change a template** is its saver or the group's owner (`NotTheSaverOrTheOwner` for any other member); a non-member does not see
  the group, so it is not found.
- **Replacing keeps the saver and the template's place** in the order the group's templates are listed in, the earliest saved first.

## Consequences

- The checks of a template's members run on save, on replace and on use: a member who leaves after a template is saved is refused at its
  use, and the template is kept for the members who remain to change.
- The storm checker attributes a call `x.name(` to any aggregate of the context with a behaviour of that name. The aggregate's behaviours are
  therefore named `register` (the creation, which the conventions name) and `replaceWith`, not `save` or `replace`, which `Budget` and the
  repositories already use: otherwise a template's command would be attributed to Budget, or to a template's save in a command that does not
  save one.

## When to revisit

If a template should be shared between groups, or should list members who are not yet in the group, the aggregate's `register` is where the
rule is decided, and the port that reads membership changes with it.
