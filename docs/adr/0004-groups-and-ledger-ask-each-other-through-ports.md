# 4. Groups and Ledger ask each other through ports, and a leaver is kept

## Context

Feature 9 (leave a group) is the first change that needs a relationship from Ledger to Groups, besides the one
ADR 3 carries. A member may leave only with a balance of 0, and only Ledger knows the balances, so Groups must ask
Ledger (the link declared `planned` in the context map since ADR 1, T5). Leaving also changes what Ledger reads
from Groups: a member who left must not be in a split, must not pay, must not change an expense they were in, and
must still have a statement that the group's members can read. Until now membership was never removed, so Ledger's
statement and its checks relied on that.

Two contexts that ask each other through ports make a cycle between their wiring files: Groups' wiring imports
Ledger's for its balances, and Ledger's already imports Groups' for membership.

## Decision

- **Groups owns the port** `IMemberBalances` (`Groups/Domain/Group/Ports`): `balanceOf(groupId, accountId)`, an integer,
  0 when nothing is recorded. The leave is decided by the Group: `leave({ accountId, balance, now })` refuses while the
  balance is not 0, refuses the owner, and records `MemberLeft`. The balance is a plain value the aggregate validates
  (DOMAIN-NON-DETERMINISM).
- **Ledger publishes a read-model port** `IMemberBalancesQueries` (`Ledger/Domain/Expense/Ports`), answered by
  `SqliteMemberBalances`, the read model the expenses are counted into. Ledger's wiring exports it as `memberBalances`.
- **The adapter lives in Groups' Infrastructure**: `BalancesFromLedger` implements `IMemberBalances` over Ledger's
  read-model port, as ADR 3's adapter does the other way. Groups' wiring imports only that export.
- **A leaver is kept, not erased.** Groups keeps the membership row with the time it left (`group_members.left_at`); the
  Group aggregate keeps its `departed` members apart from its `members`. Membership in every read (groups, members,
  balances, the leave's check) is the members who have not left. `hasBeenMemberOf` answers for a former member too, so
  that a member's statement can be read after they left.
- **A former member who joins again** is taken up as a new member: last in the order, joined at the time they join,
  with the balance their earlier expenses give them. The expenses they were in are changeable again only while they are
  a member.
- **Ledger refuses to change an expense of a former member.** The Expense refuses an edit or a delete when its payer or
  one of its split members is not a current member (`ExpenseConcernsAFormerMember`): their balance stays 0 and the
  group's balances still add up to 0. Ledger reads the members when it decides, as it does for joining; it is not told
  of the leave (`MemberLeft` is Groups' own fact).
- **The wirings import each other**: Groups' wiring for `memberBalances`, Ledger's for `groupMembers`. Each adapter
  receives the other's export as a function, and reads it when it is asked, not while the two files are evaluated;
  otherwise whichever file is evaluated first would read the other's binding before it exists. The composition root's
  end-to-end test starts the application, which is where an eager read would fail.

## Consequences

- The context map declares the Ledger → Groups relationship as carried (no longer `planned`).
- `GroupSnapshot` has a `departed` list: a stored group written before this change has none, and is read as having no
  former members, which is what it was.
- Groups' membership rows are never deleted: a group's history of members is its own. The read models filter by
  `left_at`, so each one that lists or checks members must keep filtering.
- The known gap of the storm stands: an expense recorded in the very moment its member leaves is decided in two
  contexts, and no transaction spans them. The alternative (one transaction across both, or a saga) is out of
  proportion here.

## When to revisit

When a third context needs the same membership or balances, or when the two wirings' cycle becomes a hindrance to
reading the composition: then the adapters move to the composition root, which holds both contexts and imports neither
wiring. A change that lets a leave and an expense be decided in one transaction reopens the storm's known gap.
