# 18. A group is archived by its owner, decided by Groups, and every change in it is refused by one name

## Context

Request 27 lets the owner of a group archive it once every member's balance is 0 and no settlement through the provider is pending or being
refunded. An archived group stays archived and is read only: recording, editing or deleting an expense, attaching a receipt, recording or
refunding a settlement, creating an invitation, joining, leaving, setting up or stopping a recurring expense, setting or removing a budget,
saving, replacing or removing a template, and archiving it again are all refused, by the name of one rule, the same for all of them. The
background sweep records no expense of a recurring expense in it.

The storm (`conventions/storms/archive-a-group.yaml`) decided three hot spots: that Groups decides the archive, from the balances (Ledger's)
and the payments waiting (Settlements'); that every context refuses a change by one name, asking Groups through the port it already owns and
keeping no copy of the flag; and that the recurring sweep records nothing in an archived group. It needs no new context and no new
relationship: the four links it uses (Ledger and Settlements to Groups, and Groups to each) are already in the context map (ADR 4, ADR 5).

## Decision

- **Groups decides the archive, in the `Group` aggregate.** `Group.archive` refuses, in order, a group already archived (`GroupArchived`),
  a caller who is not the owner (`OnlyTheOwnerMayArchive`), a balance that is not 0 (`BalancesNotSettled`), and a payment waiting at the
  provider (`ArchiveWaitsForPayment`); it records `GroupArchived` and stores `archivedAt`. Its inputs are read by the handler inside its
  transaction: the balances through `IMemberBalances.allBalancesOf` (Ledger's read model, every member and any other with a balance, since the
  owner of a passage may have no row of its own), and the waiting payments through `IWaitingPayments.waitingIn` (Settlements' read model).
  The non-member is `NotFound`, as for every command of the group.
- **The one refusal is a word of the shared kernel, `GroupArchived`.** It is `src/SharedKernel/Domain/GroupArchived.ts`, an `Exception` whose
  type is `GroupArchived`, so every context gives the same name and the same message. The shared kernel was already the place for the words
  every context agrees on (Email, Role, Currency); the refusal joins them.
- **Each other context asks Groups through the port it already owns, and keeps no copy of the flag.** Ledger reads `archivedOf` through its
  `IGroupMembers`; Settlements reads `archivedOf` through its `ISettlementMembers`; both are answered by an adapter over Groups' read model,
  `isArchivedOf`, which is read inside the command's transaction and takes no lock, as the other reads of a command do. Groups reads its own
  flag, from the aggregate, for its own commands: `join` and `leave` refuse on it, and so does `Invitation.issue`, which the handler asks with
  `group.isArchived()`.
- **Each aggregate refuses before anything else it checks.** A command that would change something passes the flag into the behaviour that
  decides the change (`Expense.create`, `edit`, `delete`; `Budget.set`, `replace`, `unset`; `Receipt.attachable`; `SplitTemplate.register`,
  `replaceWith`, `remove`; `RecurringExpense.setUp`, `recordDay`, `stop`; `SettlementBook`'s decisions, `decideRefund` and `recordRefund`),
  and it refuses with `GroupArchived` first. One exception of order: `RemoveBudget` checks the owner before it looks the budget up, so its
  handler asks the flag first, and the refusal is the same name for every member.
- **The sweep records nothing in an archived group.** `RecurringExpense.recordDay` refuses with `GroupArchived`, and the sweep ends that
  recurring expense's run without reporting it as a failure. A day that was already published before the archive, and whose reaction runs
  after it, is refused by the expense's own creation (`RecurringExpenseDayCame` asks the flag too), so an archived group gets no expense from
  the sweep either way.

## Consequences

- An archived group is read as before: its members, balances, expenses, receipts, statements, settlements, suggestions, budgets, templates and
  recurring expenses are read by the queries, which do not ask the flag. `archivedAt` is added to a group's read model and its schema only
  once it is archived; an open group has no such field.
- Every change in an archived group costs one read of Groups' flag, inside the transaction the change already holds. No context stores the
  flag, so it can not be stale: a change that commits after the archive reads the archived group and is refused.
- A check the archived group needs is also the first thing a new change in another context must make: a new command that changes a group
  asks `archivedOf` through the port it owns, and passes the flag into its aggregate.
- The `RemoveBudget` exception to the order is the one place the handler answers before its aggregate; it is kept so that a member who is not
  the owner also gets `GroupArchived` rather than `NotTheOwnerOfTheGroup` in an archived group.

## When to revisit

If a change in a group that is archived should be allowed (a correction of the balances, say, or the owner's reopening of the group), that is a
new request and a new rule: the flag and its refusal are the one place to change. If a second kind of group state appears (closed, frozen), the
flag becomes a state of the group and this decision is revisited with it.
