# 6. An expense is edited and deleted by its payer or the group's owner, from the version its author read

## Context

Request 6 lets the payer of an expense, or the group's owner, give it again whole or delete it; an edit names the version
its author read, and of two edits at once one is kept. The storm (`conventions/storms/edit-and-delete-an-expense.yaml`)
decided four things: the edit's version is the Expense's own version; Ledger asks Groups each member's role through
`GroupMembers` to know the owner; a deleted expense is gone from every read and from the balances; and the payer never
changes.

Building it showed what the Lite profile says a new aggregate, a new domain event and a second writer bring in: an ADR.

- **Several writers now reach the expense.** `EditExpense` and `DeleteExpense` are two commands on one aggregate, and two
  people or two servers may send them at once. The profile's trigger `several-writers` fires for Ledger, so the
  Expense's version and its optimistic check (CONC-OPTIMISTIC, ADR 8) hold here, where ADR 4 held them out.
- **Recorded facts nothing reacts to.** `ExpenseEdited` and `ExpenseDeleted` are domain events recorded by the aggregate
  and published after the commit, as the storm decided. No other context reacts to them, so the profile's
  `reacts-to-domain-event` trigger is not what brings them in: the precedent is Groups' `GroupCreated` (ADR 4), accepted
  the same way.
- **The owner is read from GroupMembers.** The port answered only who the members are; the storm needs their roles.

## Decision

- **No new context, relationship or link.** Ledger and the `GroupMembers` link (Groups → Ledger) are already declared and
  carried (ADR 4); `conventions/domain.yaml` and `conventions/architecture.yaml` are unchanged. `Ledger → Groups`
  (`MemberBalances`) stays `planned` until request 20.
- **The version is the stored version.** A recorded expense is at version 1 (the store writes `version + 1`); each edit is one
  more. The aggregate carries the version it was read at (ADR 8) and never changes it. `GET /expenses/{id}` answers it.
- **An edit from another version is refused by name.** `Expense.edit()` refuses a version other than the one the expense
  was read at with `ExpenseChanged`. That refusal is a `ConcurrencyConflictException` with its own name, so the use case
  re-reads and re-decides it up to three times, as the building blocks do for every conflict, and the last one is the
  answer: `409 { type: 'ExpenseChanged' }`. Two edits from the same version: the first is stored, and the second, saved
  over a version that has moved, is a store conflict that re-reads into the same refusal. Nothing of the refused edit is
  kept, the store saves nothing of it, and the balances still sum to 0.
- **Who may change it.** The payer, or the member whose role in `GroupMembers` is `owner`. For anyone else in the group,
  `NotAllowed` (`403`). For anyone outside the group, or for an expense that does not exist, `NotFound` (`404`), as for
  every expense read (ADR 4). `GroupMembers` answers each member's role (`GroupMember`), so the port changed inside Ledger
  and its adapter translates Groups' `MemberView`.
- **An edit is a creation again.** `Expense.edit()` gives the description, amount, date and split again under the rules
  `register()` holds: the same refusals by the same names. The payer is kept; a split without the payer is refused
  (`PayerNotInSplit`, `422`). The split's members are the group's current members.
- **A delete is gone.** `Expense.remove()` records `ExpenseDeleted`; the store removes the expense and its shares in the
  transaction, and the balances read model forgets them with the rows. No tombstone; a deleted expense is `404` from then
  on. The store removes it only at the version it was read at, so a delete and an edit racing each other are a conflict
  too, re-read and re-decided.
- **Events are domain events, not integration events.** `ExpenseEdited` and `ExpenseDeleted` are published by the command
  after the commit; `conventions/integration-events.yaml` stays empty.
- **Rules in the aggregate, not in a decision file.** The rules are behaviours of `Expense` that record their events, as
  `Expense.register()` and `Group.register()` are: `record()` is the only way an event is made (DOMAIN-RECORDS-EVENTS).
  The Lite profile's `Decision` helper is not used by any command in this repository; moving these rules into a
  `Expense.decision.ts` would split one aggregate's rules across two shapes in the same context. Recorded as the choice,
  not as a rule of the profile.
- **Routes at the root.** `PUT /expenses/{id}` (`204`, the edit at once) and `DELETE /expenses/{id}` (`204`), in Ledger's
  routes (ADR 3).

## Consequences

- The store's `save` inserts a new expense at version 0 and updates a stored one only at the version it was read at; its
  shares are rewritten with the expense. `remove` is new. The ADR 4 note that "a stored expense is never changed" no longer
  holds: an edit changes it, and the version is what keeps two writers apart.
- A stale edit costs three read-and-decide attempts before its refusal. That is the cost of routing a version conflict
  through the building blocks' retry rather than a plain refusal; it is a refusal either way and changes nothing.
- The balances (request 5) need no change: they are read from the rows as they are, and a deleted expense has none.

## Alternatives

- **A plain `422` refusal for a stale version.** Simpler, one transaction, but the building blocks answer `409` for "another
  writer changed since it was read", which is what this is. Not taken.
- **Soft delete (a state, not gone).** The storm decided gone. Not taken.
- **Integration events for the two facts.** Nothing in another context reacts yet; a contract now would be a promise no
  one keeps. Not taken; it comes with the first reaction, by an ADR.
- **Reading the owner from Groups' read model on the shared connection.** Ledger may read Groups only through
  `GroupMembers` (ADR 1, T3), and the shared connection would deadlock inside the transaction (ADR 4). Not taken.

## When to revisit

When request 20 (a member leaving) lets an expense's payer leave the group: an edit or a delete of an expense whose payer
is no longer a member must then be decided, and `MemberBalances` (ADR 1, T5) must hold the balance a leave is refused on.
Also when a second context reacts to `ExpenseEdited` or `ExpenseDeleted`: the facts become integration events, by an ADR.
