# 29. A merged group is closed by its write, and what it holds moves in the merge or in the reactions to it

## Context

Request 31 merges a group into another of the same currency. ADR 28 decided that the expenses, recurring expenses, audit and
settlements move by one published fact, `GroupsMerged`, which Ledger and Settlements each move in a reaction of its own. Three
things were left to the implementation: how the group merged is closed so that it is gone at once, where the balances that passed
to an owner when a member left (request 20) live and so who moves them, and which versions the moved rows keep.

## Decision

- **Groups closes the group merged in the merge's own write.** The group merged is stored with `merged_into` set to the group kept, and
  its members are removed in the same transaction. Every read of a group by its id excludes a merged one, so it is no group for anyone at
  once: no member, no invitation to it can be accepted, and no expense or settlement is recorded in it (Ledger and Settlements find no member).
- **The passes are Groups' own, so Groups moves them.** The balances that passed to an owner are a table of Groups, read by Ledger's balance
  count through its `GroupMembers` port. Ledger has no copy to move, so the merge's own transaction re-points them to the group kept
  (`movePasses`) beside the members. The storm's list of what Ledger moves is therefore Ledger's expenses, recurring expenses and audit,
  and Settlements' book; the passes are moved where they are held.
- **A move keeps the version.** An expense, a recurring expense and their audit entries are moved, not edited: the moved expense keeps its
  id, version, payer, shares, category and its place in the order it was recorded (its `recorded_seq`), so a move never makes an edit
  conflict with a read, and the group kept's lists show them at their place. A move checks the version it was read at, as a save does.
- **The settlement book takes the settlements over, and its version moves.** The group kept's book takes the settlements of the group
  merged, each with its status and history, and its version is stored + 1 in the same transaction, so a settlement recorded at the same
  time reads a book that has changed.
- **Budgets and split templates are not moved.** They stay under the id of the group merged, which no one can reach once it is closed.
- **The same moment is decided by the writers' lock.** Every write transaction takes the database's one writers' lock (ADR 17), so an
  expense or a settlement recorded in the group merged either commits before the merge and moves with it, or after it and is refused
  because the group is closed.

## Consequences

- A merge is one write in Groups and two reactions, each in its own transaction: a member's balance is the sum of the reactions once both
  have run, within seconds, as ADR 28 says. The zero sum holds throughout: an expense and a settlement count the same in both groups, and
  a pass moves its amount from a member to the owner.
- The published language gains `GroupsMerged` (version 1), and the domain map drops the `planned` mark on the two relationships it carries.
