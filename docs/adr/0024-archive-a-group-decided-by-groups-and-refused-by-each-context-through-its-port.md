# 24. Archiving a group: Groups decides and keeps the flag, each context asks through a port it owns and refuses by `GroupArchived`

## Context

Request 27 (`api/27-archive-a-group.yaml`) lets the owner of a group archive it once every member's balance is 0 and no settlement through the
provider is `pending` or `refunding`. An archived group stays archived. Every request that would change something in it is refused by the name
of one rule, the same for all of them, and changes nothing: recording, editing or deleting an expense, attaching a receipt, recording or asking
for a settlement, refunding one, creating an invitation, joining, leaving, setting up or stopping a recurring expense, setting or removing a
budget, saving, replacing or removing a template, and archiving it again. The background job records no expense in it. Its members still read it,
and the group reads `archivedAt` once, and only once, it is archived.

The storm (`conventions/storms/archive-a-group.yaml`) was decided before the code. It needs no new context and no new relationship: the four links
it carries (Ledger and Settlements read Groups' archive through their ports, and Groups reads the balances of Ledger and the waiting payments of
Settlements through its own) are already declared in the context map (ADR 5, ADR 7, ADR 10, ADR 16), and the map is unchanged.

## Decision

- **Groups decides an archive, and keeps the flag.** `Group` gets `archivedAt`, set by `Group.archive(at)`, which records `GroupArchived` (a domain
  event of Groups, with no subscriber: the other contexts do not learn it by an event). `archivedAt` is stored in the groups' file (an additive column,
  `NULL` while the group is not archived) and read back; a group that is not archived has no `archivedAt` in an answer, not a `null`.
- **The rules are a pure decision** (`Group.decision.ts`, `decideArchiveGroup`). Given whether the group is archived, its owner, every member's balance
  and whether a payment through the provider is pending or refunding in it, it refuses, in order: an archive made already (`GroupArchived`), a caller
  who is not the owner (`NotAllowed`), a balance that is not 0 (`BalancesNotSettled`), a waiting payment (`PaymentsWaiting`). The use case reads the
  balances through `IMemberBalances` and the waiting payments through `IWaitingPayments`, one member at a time, in the one transaction on the groups'
  file that saves the group, as a leaving does (ADR 16, ADR 17). The group is saved at the version it was read at (CONC-OPTIMISTIC).
- **One rule's name, in one place.** `GroupArchivedException` (`type: 'GroupArchived'`) is a word of the shared kernel (`SharedKernel/Domain/GroupArchived.ts`),
  so every context names the refusal the same way. The shared kernel imports the building blocks and no context, as it did before.
- **Each context asks Groups through the port it already owns, and refuses in its decision.** Ledger's `IGroupMembers` and Settlements'
  `ISettlementMembers` gain one question, `archivedOf(groupId)`, answered by the adapter over Groups' read model (`GroupMembersOfGroups`,
  `SettlementMembersOfGroups`), which answers `IGroupQueries.archivedOf`. The use case reads it after it has checked that the caller is a member, and
  passes it into the decision as a given fact (`archived`), next to the members and the owner it already gives. Each decision checks it first, so
  the refusal is the one rule whatever else would be refused. No context keeps a copy of the flag.
- **Groups' own changes.** `Group.join()` and `Group.leave()` refuse with `GroupArchived` first, and `decideLeaveGroup` does too (`archived` is one of
  its given facts). `createInvitation` refuses on the group it reads.
- **The background job records nothing.** `decideSweepRecurringExpense` decides no day in an archived group, so the sweep moves no `next` and records no
  expense (the sweep is what decides the days). `RecurringExpenseDayCameHandler` checks the archive too, for a day the sweep decided before the archive:
  it ends the day without an expense.
- **Answers.** `POST /groups/{id}/archive` answers at once: `204` when archived, `404` to a non-member, `403 NotAllowed` to a member who is not the owner,
  `400` for the rule that refuses (`BalancesNotSettled`, `PaymentsWaiting`, `GroupArchived`). `GET /groups/{id}` and `GET /groups/mine` answer
  `archivedAt` once the group is archived.

## Consequences

- The check and the write of a change are in the same transaction of its own file, but a change and an archive are in two files (Groups' and the
  file of the context that makes the change). An archive that reads the balances while a change to another file is between its check and its commit
  can be overtaken by it: the group is then archived with a balance that is not 0. SQLite has no transaction across the files, and ADR 16 accepted the
  same window for a member leaving while a settlement is recorded in another file, so this is known and kept, not solved here. The archive refuses to
  start while a payment waits, which is the case the storm named; a change of an expense recorded at the same instant is not guarded.
- A group archived before a sweep records a day is unaffected: the handler refuses that day too, so an expense is never recorded in an archived group,
  at the cost of one extra port question for each recorded day.
- Every decision that changes a group now takes `archived` in its given facts. A test that builds those facts must say `archived: false`, which is why the
  decision specs changed.

## When to revisit

When the stores of the contexts can share one transaction (the window above closes), or when an archived group can be unarchived (then `archivedAt`
becomes a state with two values, and the flag is read as the latest of them).
