# 4. Leaving a group: Groups asks Ledger a member's balance, and a former member keeps its rows

## Context

Request 9 lets a member leave a group once their balance in it is 0, and refuses the owner. T5 of ADR 1 decided that
Groups asks Ledger that balance through a port it owns, `MemberBalances`, and ADR 1 declared the relationship
`Ledger → Groups` `planned` until the code carried it. Until now only Groups knew the members, and no member ever
stopped being one, so the members' rows, the reads over them and the expenses' checks all assumed a membership that
only grows.

Two consequences follow from the request. A former member must stop being a member for every current read (the group
does not exist for them, they are not in the list, the balances or a split), yet remain a member for every read of
what they did (their statement, the expenses they were in, and the rule that they may be read at all). And the wiring
has a cycle to avoid: Ledger's wiring already imports Groups' wiring (ADR 3), so Groups' wiring cannot import Ledger's.

## Decision

- **Groups asks Ledger a member's balance through `IMemberBalances`**, in `Domain/Group/Ports`: `balanceOf(groupId,
  accountId)`. The command `LeaveGroup` asks it when it decides, inside its own transaction, and the aggregate
  `Group.leave` refuses on a plain value it is given: the owner always, a non-member, and any balance other than 0.
- **The adapter is Groups'**, `LedgerMemberBalances` in `Infrastructure`, which answers the port by reading Ledger's
  read port `IMemberBalanceSums` (`balanceOf(groupId, memberId)`), declared in Ledger's `Domain/Expense/Ports`, the same
  shape as ADR 3's pair. Ledger's wiring exports `memberBalanceSumsInCommand`, reading the connection the command's
  transaction holds (ADR 2), never `exclusive()`, which would wait for that same transaction.
- **The two wirings do not import each other.** Ledger's wiring imports Groups' (ADR 3), so Groups' wiring exports
  `groupsModuleWith(memberBalances)`: the module, given the port. `createApplication` (the composition root) builds it
  from `LedgerMemberBalances` over Ledger's export. Neither wiring reaches the other's Application.
- **A leaving member keeps its rows.** A membership now carries when it left (`left_at`, null while it is a member).
  Every read of who is a member, the group a member can see, the roles, the members' list and the balances lists the
  current members only. Ledger's `IGroupMembers` gains `hasBeenMember`, answered by Groups' `IGroupMembership`, so that
  a member's statement can still be read by the members of the group, as a former member's can, while a statement of
  someone never a member does not exist.
- **A member who joins again is last, from that moment.** `Group.join` replaces the former membership by a new one at the
  end of the order, with the join time of now; its balance is the one its earlier expenses give, which is 0 when it left.
- **An expense of a former member cannot change.** `Expense.edit` and the new `Expense.delete` (which now takes the
  current members, as edit does) refuse an expense whose payer or split holds a member who is no longer one
  (`FormerMemberInExpense`), so that their balance stays 0 and the balances still add up to 0. A member who joins again
  is a current member again, and the expense can be changed again.
- **Leaving is not told to Ledger.** Ledger reads the members when it decides, as for joining (the storm's decision);
  `MemberLeft` is Groups' own domain event, with no subscriber.
- **The gap of T5 stays.** An expense recorded at the very moment its member leaves is not ordered against the leave: the
  two commands are in two contexts, each in its own transaction. This is accepted, as in the storm.

## Consequences

- `group_members` gains `left_at`. A database file made before this request needs that column added (`ALTER TABLE
  group_members ADD COLUMN left_at TEXT`); the statements create it for a new file.
- `Ledger → Groups` loses its `planned` flag in `conventions/domain.yaml`; `Groups → Ledger` is unchanged.
- Groups' module is now built by a function of its port rather than a constant. The composition root is the only place
  that builds it, and it is the only place that knows both wirings.

## When to revisit

If a second command needs Ledger's read, the composition root is where its port is bound; if the leave and an expense
must be ordered (T5's gap), the alternative is one transaction across Groups and Ledger or a saga, which request 20's
change would reopen.
