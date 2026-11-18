# 23. A merged group is removed in the write that keeps the other, and a move keeps the version it was read at

## Context

ADR 22 decided that a merge is one fact, `GroupsMerged`, which Ledger and Settlements each move their own in a reaction of its own. Building it
settled four things the storm does not say: where the group merged goes, what a move does to an aggregate's version, how a former member of the
group merged becomes one of the group kept, and what Groups moves itself.

## Decision

- **The group merged is removed in the write that keeps the group kept** (request 31): `GroupRepository.saveMerged` saves the group kept as
  `save` does, then deletes the group merged at its version, with its members, its invitations and its passages. Nothing reads it afterwards, so
  it is 404 for anyone at once, and a second merge of it finds nothing.
- **Groups moves what it holds itself, in that write**: the members of the group merged join the group kept at the merge, after its members, in
  their order there; its former members are former members of the group kept (`absorb`); its passages are the group kept's from the save on; its
  audit entries (request 28) are kept under the group kept's id. These are Groups' own rows, so they move in Groups' transaction, not in a reaction.
  This is a difference from the storm's wording, which names Ledger for the passed balances: they are Groups' facts, read by Ledger through
  `GroupMembers`, and moving them in Ledger would leave them in the group merged for a few seconds.
- **A move is not a change**: `Expense.moveTo` and `RecurringExpense.moveTo` return the aggregate in the group kept at the version they were read at, and
  the repositories' `move` stores only the group, under a check of that version. An expense keeps its version, as request 31 asks. `save` keeps its
  rule (CONC-OPTIMISTIC): it still stores version + 1.
- **The balances move as rows**: `member_balances` of the group merged are added to the group kept's and deleted (`moveGroup`), in the reaction's
  transaction. The sum is 0 in each group before and after, so it is 0 at every moment.
- **Budgets and split templates of the group merged are dropped** in Ledger's reaction, with the months a budget was passed in.
- **Settlements' book moves as a book**: the group kept's book records `SettlementBookMerged`, and its save moves the settlements and their audit
  entries under the group kept, and deletes the group merged's book.

## Consequences

- A reaction is idempotent by what it finds: a second delivery finds nothing left under the group merged.
- Between the merge's write and the reactions, a member's balance in the group kept counts the passages and not yet the expenses, settlements or
  balances moved from the group merged. The passages pair up to 0, so the sum is 0 throughout; the request's "within seconds" holds.

## When to revisit

If a group's expenses grow so that the reaction takes seconds, it moves them in batches, each in its own transaction, and the group merged keeps its
id until the last batch: the storm and this ADR both change then.
