# 3. Ledger reads who may be in a split from Groups, through a port it owns

## Context

Feature 4 (record an expense, split equally) is the first feature that needs a relationship between two contexts.
ADR 1 decided that Ledger asks Groups who may be in a split, through a port it owns (`GroupMembers`, T3), and the
context map declared that link `planned` until the code carried it. This ADR records how the code carries it.

The convention for a port to another context puts the adapter in the asking context's Infrastructure, which may
read another context's Domain but not its Application. Groups' read models, though, live under Application
(`IGroupQueries`, `GroupReadModel`), so Ledger's adapter could not reach them.

## Decision

- **Ledger owns the port** `IGroupMembers` in `Ledger/Domain/Expense/Ports`: `membersOf(groupId)` returns the ids of the
  group's current members in the order they joined, and none when there is no such group. Ledger words it its own way.
- **Groups publishes a read-model port in its Domain**: `IGroupMembersQueries` (`Groups/Domain/Group/Ports`), with
  `memberIdsOf(groupId)`. Its adapter is the one Groups already has over its tables (`SqliteGroupReadModels`), which now
  implements it too. The existing `IGroupQueries` stays where it is.
- **The adapter lives in Ledger's Infrastructure**: `GroupMembersFromGroups` implements `IGroupMembers` over Groups'
  read-model port, translating the ids into Ledger's words.
- **Groups' wiring exports its read-model adapter** (`groupMembers`), and Ledger's wiring imports only that export
  (ARCH-WIRING). Ledger never imports Groups' Application or Infrastructure.
- **The caller's membership is decided by Ledger**, not by the port: the command and the query each ask
  `membersOf` and refuse a caller who is not in it with NotFound, as Groups does for a group that is not there.
- The context map declares the Groups → Ledger relationship as carried (no longer `planned`). The reverse one,
  Ledger → Groups for the balances (T5), stays `planned` until request 20.

## Consequences

- A member who has just joined can record an expense at once: the port is read when the command is decided.
- Groups exposes one more read-model port; a change to how members are kept has to keep `memberIdsOf` true.
- The adapter is a second, small read of the membership; it is cheap and inside one SQLite file (ADR 2).
- Two reads, by where they are made: the command deciding a split asks `membersOf` inside its own transaction, which
  must not take the database lock (`exclusive` waits for the transaction in progress, so inside it would wait for
  itself); a query asks `isMember` outside any transaction, which takes the lock as every other read model does.

## When to revisit

When request 20 (leaving) makes Ledger and Groups both ask each other, and the second port (`MemberBalances`) is built;
and if the membership ever stops being one file, the port is the seam that changes.
