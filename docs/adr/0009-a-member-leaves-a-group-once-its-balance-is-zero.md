# 9. A member leaves a group once its balance is 0, and a former member keeps its place in the record

## Context

Feature 9 (request 9) lets a member leave a group once they are even: `POST /groups/{id}/leave`, answered at once. The storm
(`conventions/storms/leave-a-group.yaml`) decided four things: Groups asks Ledger a member's balance through a port it owns,
`MemberBalances`, when it decides (T5); the owner stays; an expense of a former member can no longer change, which the Expense
asks of the current members (GroupMembers); and Ledger is not told of the departure, since it reads the members when it decides,
as for joining.

Building it showed what the storm left to the code, and the Lite profile says a new domain event, a new cross-context read and
a change to who a read answers come in only by an ADR.

- **The record of who has been a member.** Groups kept a membership row that was inserted and never removed, and its members'
  list was the record of who was a member. A leave cannot delete the row: who has ever been a member is what Groups knows
  (ADR 1), and a former member's statement stays readable by the group's members (request 9), which Ledger can answer only if the
  record still says who was one.
- **The wiring would import itself.** Ledger's wiring read Groups' read model from Groups' wiring file (ADR 4). Groups now needs
  Ledger's balances, so its wiring would import Ledger's and Ledger's would import Groups'. The two modules load in a cycle, and
  a binding read at the top of one of them before the other has finished is a `ReferenceError` that depends on the order the
  application imports them in.

## Decision

- **The link is carried, so it is no longer `planned`.** `conventions/domain.yaml` drops `planned: true` from Ledger → Groups
  (`owned-port`, `MemberBalances`, T5). The `MemberBalances` port is Groups' own, `IMemberBalances.balanceOf(groupId, accountId)`
  in Groups' Domain, in Groups' words: a number. Its adapter `MemberBalancesOfLedger` in Groups' Infrastructure implements it over
  Ledger's `IExpenseQueries`, and reads Ledger's balances through its read model, as Ledger's `GroupMembersOfGroups` reads Groups'.
- **A leave is decided by the Group, with the balance asked.** `LeaveGroup` (`command`, at once, signed-in) finds the group, refuses
  a caller who is not a current member as if the group did not exist (`NotFound`), asks the balance through the port, then
  `Group.leave({ accountId, balance, at })` decides: the owner is refused (`OwnerCannotLeave`), a balance that is not 0 is refused
  (`BalanceNotZero`), and otherwise the member is kept as left at `at` and `MemberLeft` is recorded, stored with the group in the
  same transaction and published after the commit. `MemberLeft` is a domain event of Groups; no integration event carries it,
  since Ledger reads the members when it decides (T3).
- **Membership keeps its history.** The `group_members` rows are never deleted: a leaving member gets `left_at`, and the store
  upserts every membership in the order the aggregate keeps them, so `position` stays the order of the memberships. A former
  member is not among the current members, the group is not among its groups, and it does not find the group (every current-
  member read filters `left_at IS NULL`). A former member who joins again is put last, as a new member, with its new `joined_at`
  and its earlier entry replaced; its balance is 0, as the leave required. Stores made before this feature get the column on
  open (`prepareGroupsSchema`).
- **The record of who has been a member is read as a fact.** `IGroupQueries.everMemberOf(accountId, groupId)` says whether an
  account is or has been a member; Ledger's `IGroupMembers.hasBeenMember(groupId, memberId)` asks it through the adapter. The
  statement (request 8) checks that the caller is a current member, then that the member has been one, so a former member's
  statement is readable by the group's members, and a stranger's is not.
- **An expense of a former member is kept as it was.** `Expense.edit()` and `Expense.remove()` refuse, after the payer or the
  owner check, an expense whose payer or any member of whose split is no longer a current member: `ExpenseOfFormerMember`
  (`422`). That keeps the shares, and so the group's balances, as they were, with a former member's balance at 0. Recording an
  expense already refuses a former member, since the split takes only current members.
- **The read models move to the composition root.** `src/Bootstrap/Fastify/readModels.ts` opens `groupsReadModel` and
  `ledgerReadModel`, each over a connection of its own, and both contexts' wiring files import them from there. ADR 4 placed
  `groupsReadModel` in Groups' wiring; that placement is superseded by this one, for the reason above. The composition root is
  not a context, and its import is allowed by the table (ARCH-WIRING names `bootstrap`).

## Consequences

- The storm (`conventions/storms/leave-a-group.yaml`) is met by the code: the command, the event and the link. Its four hot
  spots are decided as the storm says; the storm's hot spots are not changed.
- ADR 4's snapshot gap and ADR 5's "membership only grows" are narrowed, not closed. The balances are read before the members
  (ADR 5), which stays correct after a leave: a member who leaves had a balance of 0, so the listed balances still add up to 0.
- **The known gap stays open, as the storm accepted.** A leave decides on the balance it reads; an expense that includes the
  member and is recorded between that read and the leave's commit leaves a former member with a balance that is not 0, which
  no member's list shows. No hidden test sends the two at once, and the alternative (one transaction across Groups and Ledger,
  or a saga) is out of proportion for this checkpoint. The next feature that changes the balances' reads (T5 in the README) reopens it.
- A former member's row stays in the store, so the group's members can be listed as they were, and a member who rejoins has a new
  join date and a new place. Who has ever been a member is answered from the same row, which is why the row is kept.

## Alternatives

- **Delete the membership row on leave.** It makes "who has ever been a member" unknowable, and a former member's statement
  unreadable. Not taken.
- **Publish `MemberLeft` as an integration event to Ledger.** Ledger reads the members when it decides, as for joining (T3); it
  needs no copy of the membership to refuse an expense of a former member. Not taken until a reader needs the event.
- **Keep the cross-context read models in the wiring files and break the cycle with lazy access.** It works only while the modules
  load in one order, and a closure over a binding that is not yet initialised fails at the first request. Not taken.

## When to revisit

When the balances or the members are read in one transaction (T5's alternative, or a saga across Groups and Ledger): then the
known gap is closed, and the read models' separate connections may go. Also when Notifications reacts to `MemberLeft` (ADR 1's
checkpoint 2): then the event is published to the other contexts as an integration event, and the published language declares it.
