# 18. Groups archives a group, and every context refuses a change in it by one rule (no new context, no new relationship)

## Context

Request 27 has the owner of a group archive it, once every balance is 0 and no settlement through the provider is pending or
refunding. An archived group is read only: each request that would change something in it is refused, by the same rule's name, and
changes nothing; the background job records nothing in it. The storm `archive-a-group` decided three hot spots with the product's
owner: who decides that a group is archived, how every context refuses a change by one name, and what the background job does. This
ADR records what the storm left to the code. The four links it needs already exist: Ledger and Settlements each ask Groups for the
membership through their own ports, and Groups asks Ledger for the balances and Settlements for the waiting payments through its own
ports (ADR 5, ADR 7, ADR 11). No context and no relationship is added.

## Decision

- **Groups decides that a group is archived.** `Group.archive` is the one behaviour that records `GroupArchived`. It takes the
  caller, the balances of the members and whether a payment through the provider waits, as plain values read through Groups' own
  ports (`IMemberBalances.balancesOf`, `IWaitingPayments.hasWaitingPaymentIn`), in the archive's own transaction. It refuses in this
  order: `GroupArchived` when the group is archived already, `NotAllowed` when the caller is not its owner, and `GroupNotSettled`
  when a balance is not 0 or a payment waits. A caller who is not a member finds no group (`NotFound`), as for leaving.
- **Every context refuses by `GroupArchived`, a word of the shared kernel** (`GroupArchivedException`, `SharedKernel/Domain`), a
  conflict (`409`) with the same `type` whatever the change. No context keeps a copy of the flag. Each asks Groups through the
  membership port it already owns (`IGroupMembers.isArchived` for Ledger, `ISettlementMembers.isArchived` for Settlements), once it has
  found the caller a member, and refuses before anything changes. Groups refuses its own joins and leaves in the `Group` aggregate, and
  an invitation in its handler, which holds the group.
- **The background job records nothing in an archived group.** The sweep of recurring expenses (request 23) and the policy on a due day
  each ask Ledger's membership port whether the group is archived, and record nothing when it is. The day is not moved on: a group
  archived has no days recorded, and it reads the same as before.
- **The read.** `archivedAt` is an answer of the group only once it is archived (`GET /v1/groups/{id}`, `GET /v1/groups/mine`); a group
  not archived has no such property, and an archived group keeps it.

## Consequences

- The refusal sits in the command handlers of Ledger and Settlements, after the membership check, not in each of their aggregates. The
  storm's hot spot asks for the aggregate. Ledger's and Settlements' aggregates do not hold the group, and passing a flag into every
  one of their behaviours would change each signature for one rule; the handler is where the port is asked. Where an aggregate holds the
  group (Groups), the aggregate refuses.
- A read is never refused by the archive: the read models answer every read as before, and the group stays among its members' groups.
