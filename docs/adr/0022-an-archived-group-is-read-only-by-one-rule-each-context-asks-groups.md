# 22. An archived group is read only: Groups decides it, the shared kernel names its one rule, and each context asks Groups through its own port

## Context

Request 27 of Tally (the group's owner archives a group once every balance is 0 and no payment through the provider is pending or refunding;
an archived group is read only, and reads as before, with `archivedAt`) was stormed before the code (`conventions/storms/archive-a-group.yaml`,
decided with the product's owner). Every change in an archived group is refused by one rule's name, in every context, and the background
job records nothing in it.

No context and no relationship are new. The four links the storm needs are already declared and carried (the map): Ledger → Groups
(`MemberBalances`), Settlements → Groups (`WaitingPayments`), Groups → Ledger (`GroupMembers`) and Groups → Settlements (`SettlementMembers`).
Each gains one answer, `isArchived`, and nothing else crosses a boundary.

## Decision

- **Groups decides.** The group aggregate holds `archivedAt`. `Group.archive` is pure: it takes the owner's id and a reading of the balances
  (every member's balance is 0) and of the payments waiting at the provider, which the use case reads for each member in its own transaction. It
  refuses with `403` to a member who is not the owner, `422` `GroupNotSettled` while a balance is not 0 or a payment waits, and `422`
  `GroupArchived` to a group archived already. It records `GroupArchived`, which nothing subscribes to. The archive is one row in
  `group_archives`, written once and never removed, so an archived group is never unarchived. The command `ArchiveGroup` is answered at once
  (`POST /groups/{id}/archive`, `204`).
- **One rule's name is a word of the shared kernel.** `GroupArchivedException` and `GROUP_ARCHIVED` live in `src/SharedKernel/Domain/GroupArchived.ts`:
  the type is `GroupArchived`, the status `422` (ADR 4). The kernel imports the building blocks and no context, so every context can name it.
- **Each context asks Groups through the port it owns.** Ledger's `IGroupMembers` and Settlements' `ISettlementMembers` gain `isArchived(groupId)`,
  answered by an adapter over Groups' roster. The context reads it inside its own transaction, after its `404` for a non-member, and passes the
  plain boolean to its aggregate, which refuses first with `GroupArchived`. No context keeps a copy of the flag, so nothing changes in an archived
  group before the context has heard that it is archived.
- **Groups refuses its own changes by its aggregate too**: `Group.openForChanges()` is the one check, used by `join`, `leave`, and the creation of
  an invitation, so joining an archived group by an invitation made before the archive is refused the same way.
- **The background job records nothing in an archived group.** The recurring expense's sweep leaves the expense untouched there (no day recorded,
  `next` not advanced, nothing saved or removed), and the reaction that records a day fails with `GroupArchived` and records nothing.
- **A provider webhook that would change a settlement of an archived group is refused** with `GroupArchived` and changes nothing; a verdict that
  changes nothing is still acknowledged. Archiving needs no settlement pending or refunding, so only a paid settlement can reach this path.
- **Order of refusals.** A caller who is not a member gets the group's `404` first (the group is not there for them); then `GroupArchived`, before
  any other refusal of the use case. Reads are unchanged, so members read an archived group as before.

## Consequences

- No new context, no new relationship, no new integration event, and no change to the published language. `GroupArchived` is a domain event of
  Groups; it is not published to another context.
- The Lite profile holds: the group was already an aggregate (ADR 5), and no new trigger fires.
- Each changed aggregate method takes an explicit `archived` boolean, and the specs of those aggregates check the refusal.
- `api/27-archive-a-group.yaml` is the fragment the routes answer: the group's `archivedAt`, and `POST /groups/{id}/archive` answering `2xx`.
- The storm `conventions/storms/archive-a-group.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
- A change and an archive at the same moment are serialized by the database's writer, as a leave is (ADR 15): the change reads the archive's
  committed state. This is not separately tested across two servers.
