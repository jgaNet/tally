# 31. A merged group is removed, and what it held moves to the group kept by the GroupsMerged fact

## Context

Request 31 lets the owner of two groups of one currency merge one into the other. The session of checkpoint 4 decided how
the expenses and the settlements move (ADR 30: one fact, `GroupsMerged`, that Groups publishes and Ledger and Settlements
each move their own by), and the storm of the feature (conventions/storms/merge-groups.yaml) decided the hot spots: who
decides, how the moves are reactions, why the zero sum holds while they run, and what the group merged keeps. What the
session did not decide is how the group merged stops to exist, what happens to its memberships and passed balances, and
how each context moves its rows.

## Decision

- **Groups decides the merge, in one transaction.** `Group.absorb()` on the group kept, reading the group merged
  (`MergeGroups`, answered at once). It is refused, and nothing changes, when the two are one group, when either is
  archived (GroupArchived, as any change in an archived group), when the caller does not own both (NotAllowed), when the
  currencies differ, and when a payment in the group merged waits at the provider (WaitingPayments, read through the
  port Groups owns, as archiving reads it). It records `GroupsMerged`.
- **The members join the group kept by their merged order, with the role `member`, at the merge's instant.** A member of
  both stays where it is. A former member of the group merged is a former member of the group kept, so its statement is
  read there. A member who left the group kept and is one of the group merged joins again, last, as a new member.
- **Passed balances add up on the membership.** What each member passed to the owner, in either group, is summed on its
  membership in the group kept. Ledger's balances carry the passed amounts from the memberships (docs/adr/0019), so each
  balance in the group kept is what it was there plus what it was in the group merged, the owner carrying the sum of both.
  The passed balances themselves (the group's audit rows, request 28) move to the group kept in the same transaction.
- **The group merged is removed in the same transaction.** Its memberships and its invitations go with it, and so does the
  group row, at its version; a merge that finds the group merged changed is refused, as any conflict. The removal is what
  makes it 404 for anyone at once, and what stops its invitations from letting anyone join. Its budgets and split templates
  are not moved: they go with the group merged (Ledger's reaction below), the group kept's hold.
- **Each context moves its own rows in a reaction of its own.** Groups publishes `GroupsMerged` through the outbox after
  its commit (`GroupsMergedHandler`, a domain event handler, as Ledger publishes ExpenseRecorded). Ledger's reaction moves
  each expense and each recurring expense by `moveTo()`, which records `ExpenseMoved` / `RecurringExpenseMoved`; the store
  writes only the group, keeping the version, the payer, the shares and the category, so each keeps its id and its place
  in the order (`seq`). Its audit entries and receipts change group in bulk; its budgets and split templates of the group
  merged are removed. Settlements' reaction takes the group kept's book, `absorb()`s the merged one (recording
  `SettlementBookMerged`), moves its settlements and their audit in bulk, removes the merged book, and saves the group kept's
  book one version on.
- **Concurrency at the same moment.** Every write transaction takes the database's advisory lock when it begins
  (docs/adr/0029), so a recording that reads the group's members inside its transaction either commits before the merge
  (and moves with it) or reads a group that no longer has those members (and is refused). A reaction saves the moved
  aggregates at their version, so a move that races another writer is a conflict, not a loss.
- **Both relationships are now carried.** The two relationships Groups → Ledger and Groups → Settlements over
  `GroupsMerged` are no longer `planned`: the code carries them, and the published language declares the event with its
  publisher and payload (conventions/integration-events.yaml).

## Consequences

- A member's balance in the group kept is complete only once both reactions have run; the request allows a few seconds,
  and the zero sum holds throughout, since an expense adds up to 0, a settlement moves as much up as down, and the passed
  amounts carry from a member to the owner.
- A recording in the group merged is refused once the merge is stored, because its members are gone; a recording made
  before it is moved with the rest.
- The events `ExpenseMoved` and `RecurringExpenseMoved` are recorded, and nothing reacts to them yet: they are the facts
  of the moves, kept for the day a context wants them. The same holds for `SettlementBookMerged`.
- The group merged's invitation links answer 404 after the merge; a person who had one cannot join.

## When to revisit

If a merge must keep the group merged's budgets or templates (today they go with it), or if a group must be merged
into one of another currency (today it is refused), a new decision says so; the reactions above would then move those
rows too.
