# 5. Expenses, split between the members of a group, and how Ledger knows them

## Context

Feature 4 (`conventions/storms/record-an-expense.yaml`) lets a member record an expense they paid, split equally between
members of the group, and read it back. Ledger is declared (ADR 1) and empty; the storm decided three things: Ledger asks
Groups who may be in a split through a port it owns (`GroupMembers`), one aggregate per expense, and the shares are
computed once, in a value the expense is created with.

The relationship Groups → Ledger was declared `planned` in the context map until the code carried it (ADR 1). This
feature is the first code that does, so the declaration is changed here.

## Decision

- **Ledger owns the port `GroupMembers` (`IGroupMembers` in the code)**, in its own words: `membersOf(groupId, askedBy)` answers the accounts that are
  members, in join order, if the asking account is one of them, and `undefined` otherwise. The use case asks as the
  caller, so a group the caller is not in does not exist for them, as it does not for Groups.
- **The adapter lives in Ledger's Infrastructure and is wired by Ledger's wiring.** `GroupMembersOfGroups` takes Groups' read
  model port (`IGroupQueries`, which lives in Groups' Domain as a context's read-model port, ARCH-INFRASTRUCTURE; only its
  `membersOf` is used) and implements the port. It is the one file of Ledger that imports Groups. Groups' wiring exports one
  thing, `groupsMembersReadModel`, its read side, and Ledger's wiring imports only that. Ledger's Domain never imports
  Groups (CTX-CONTRACTS).
- **No integration event carries membership.** Ledger asks when it decides, so a member who has just joined can be in a
  split at once (ADR 1, T3); Groups still publishes nothing when someone joins.
- **One aggregate per expense** (`Expense`). It holds its description, amount, date, payer and split, and the split keeps
  that its shares add up to the amount. The balances are not an aggregate: they come in feature 5.
- **The shares are computed in `Split`**, once, when the expense is created: each share is the amount divided by the
  number of members, rounded down, and the remainder goes whole to the payer (changed by ADR 8: from now on, to the first
  member listed; earlier expenses keep the shares they were given). They are stored with the expense in the order of the
  split and are not computed again at a read.
- **The decision is pure** (`decideRecordExpense`). It takes the group's members as its given state, checks the
  description, amount, date (a real day, not after today in UTC, from the one clock), that every member of the split is
  a member of the group, and then the split itself (each listed once, the payer among them). Refusals are failed
  Results named by their exception (`400`), and a caller who is not a member gets `404`.
- **Ledger keeps its own tables in a SQLite file**: `LEDGER_DATABASE_PATH`, or the application's `DATABASE_PATH` when that
  is not set. The tables are Ledger's (`ledger_*`); Groups' tables are not read from Ledger.

## Consequences

- The context map (`conventions/domain.yaml`) declares Groups → Ledger as carried: its contract `GroupMembers` is read
  from the code, and the check holds the declaration to that. Ledger → Groups (`MemberBalances`, ADR 1 T5) stays
  `planned` until feature 9 or whichever request leaving a group needs it.
- Groups' wiring exports a read model that Ledger depends on. Changing `IGroupQueries.membersOf` changes Ledger's
  adapter, not its domain.
- An expense recorded in the same moment as a member leaves could still name a former member (ADR 1, the known gap T5).

## When to revisit

- When feature 5 (balances) needs an expense's shares read in bulk: a second read in Ledger's own words, not a second
  port over Groups.
- If Ledger's tables ever move to a store of their own, `LEDGER_DATABASE_PATH` is the seam; nothing else changes.
