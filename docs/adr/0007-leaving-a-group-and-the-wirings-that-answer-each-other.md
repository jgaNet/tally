# 7. Leaving a group, and the two wirings that answer each other

## Context

Feature 9 (`conventions/storms/leave-a-group.yaml`, request 9) lets a member leave a group once their balance in it is 0; the
owner never leaves. Leaving makes the member's group disappear for them and keeps what concerns them as it was: their expenses
keep their shares, their statement stays readable by the group's members, and no expense of theirs can be edited or deleted,
so that their balance stays 0 and the group's balances still add up to 0.

The storm decided two relationships, both already named in the context map (ADR 1, T5): Groups asks Ledger a member's balance
through a port it owns (`MemberBalances`), and Ledger keeps asking Groups who the members are (`GroupMembers`, ADR 5). The first
is the relationship this feature carries; it was declared `planned` until the code carried it.

## Decision

- **The relationship Ledger → Groups is carried, so it is no longer `planned`** in `conventions/domain.yaml`. Groups owns the
  port `MemberBalances` (`IMemberBalances`, in Groups' Application), in its own words: `balanceOf(groupId, memberId)`. Its
  adapter `BalancesOfLedger` lives in Groups' Infrastructure and reads Ledger's read model through Ledger's Domain port
  `IBalanceQueries` (`balancesOf`), which `IExpenseQueries` extends. No domain imports the other context.
- **Groups' `LeaveGroup` decides in a pure function** (`decideLeaveGroup`): the owner is refused (`OwnerCannotLeave`), and a
  balance that is not 0 is refused (`BalanceNotZero`). The use case reads the balance from Ledger before deciding, then takes the
  member out with `Group.leave`, which records `MemberLeft`. The save removes the member's row; a member who joins again is
  inserted again, last, with the time they joined. `MemberLeft` is Groups' own fact and is not published to Ledger, which reads
  the members when it decides, as it does for joining (ADR 1, T3).
- **An expense that concerns a former member is frozen.** Edit and delete refuse, by name (`ExpenseHasFormerMember`), when the
  payer or a member of the split is no longer in the group. The check follows the existing refusals (permission first, then the
  version), so a member who joins again makes the expense changeable again.
- **A former member's statement stays readable while an expense of theirs is recorded.** The statement of a member is answered
  to a group member when the member is in the group, or is the payer or in the split of an expense of the group
  (`IExpenseQueries.isInvolved`). A member who never was in an expense of the group still does not exist.
- **The two wirings refer to each other, and each reads the other at a request, not at construction.** Groups' wiring now
  imports Ledger's (for `ledgerBalancesReadModel`), and Ledger's already imported Groups' (for `groupsMembersReadModel`).
  ARCH-WIRING allows a wiring to import another context's wiring for what it exports, so this is not a rule breach, but a
  module cycle would read an export before its module has evaluated. Both adapters therefore take the read model as a function
  (`BalancesOfLedger`, `GroupMembersOfGroups`), called when a request asks. The alternatives were a composition root that
  builds both adapters, which moves the context's database into Bootstrap, and a late-bound port holder, which is a service
  locator.

## Consequences

- The context map is true to the code: the link Ledger → Groups carries `MemberBalances`, and the storm
  (`conventions/storms/leave-a-group.yaml`) is done.
- The import from Groups' wiring to Ledger's makes the two wirings a cycle in the module graph. It is safe because both adapters
  dereference only at a request. A future change that reads either read model when the modules are built would fail at start-up
  with a reference error; the thunks are the place to look.
- A member who left with no expense recorded has no statement: the answer is the one for a member who never was there. Keeping
  membership history (a departure record per member) would close that, and it is cheap to add when a feature needs it.
- A member can leave in the same moment an expense is recorded with them in its split: the two decisions are in two
  contexts and no hidden test sends them at once. This is the known gap T5 (ADR 1); request 20's change reopens it.

## When to revisit

- When a request reads a former member's history beyond the statement (a departure record makes that a read, not a guess).
- When request 20 changes leaving: it reopens the known gap T5, which a transaction or a saga would close.
- If the two wirings ever need a third context, or the cycle breaks a test: the composition root is the place to move both
  adapters to.
