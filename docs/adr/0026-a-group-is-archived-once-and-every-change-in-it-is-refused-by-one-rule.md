# 26. A group is archived once every balance is 0, and every change in it is refused by one rule

## Context

Request 27: the trip is over and everyone is even. The group's owner archives the group once every member's balance (request 5) is 0 and no
settlement through the provider is `pending` or `refunding` (requests 13 and 15). An archived group stays archived. Every request that would change
something in it is refused by the one rule's name, the same for all of them, and changes nothing; the background job records nothing in it (request
23); its members read it as before, and `GET` answers `archivedAt` once it is archived, and only then.

The storm (`conventions/storms/archive-a-group.yaml`) was decided with the product's owner before any code. It adds no context and no relationship
between contexts: the four links it names (Ledger → Groups for MemberBalances, Settlements → Groups for WaitingPayments, Groups → Ledger for
GroupMembers, Groups → Settlements for SettlementMembers) already exist, and the storm's check finds them carried. What it adds is one command and
one event in Groups, and a rule that every context agrees on.

## Decision

- **Groups decides the archiving.** `Group.archive()` (`Domain/Group`) is the aggregate's decision: the caller must be the owner; every current
  member's balance must be 0; no payment of a member may wait at the provider; an archived group is refused again. The use case
  `ArchiveGroup` (`Application/Groups.ts`) reads the balances through `IMemberBalances` and the waiting payments through `IWaitingPayments`, both
  ports Groups already owns, in the same transaction, and saves the group at its version. It records `GroupArchived` (a domain event: no context
  reacts to it through an integration event, because the others ask Groups through their ports).
- **Refusals.** A caller who is not a member sees the group as not existing (`404`, as before). Otherwise: an archived group is refused by
  `GroupArchived`; a member who is not the owner by `NotAllowed` (`403`); a non-zero balance by `BalancesNotZero`; a waiting payment by
  `PaymentsWaiting` (both `422`). Nothing is recorded for a refusal.
- **The group reads `archivedAt`.** The snapshot keeps `archivedAt` once the group is archived, the store has a column for it (added to an existing
  file as the other columns were), and the read model (`GroupView`) answers it on `GET /v1/groups/{id}` and `GET /v1/groups/mine`. An unarchived group
  has no `archivedAt` key, not a `null` one.
- **One rule name, decided once.** `GroupArchivedException` lives in the shared kernel (`SharedKernel/Domain/GroupArchived.ts`), with the type
  `GroupArchived`. Every context refuses with it and names itself in `service`. No context keeps a copy of the flag: each asks Groups, through a port
  it already owns, whether the group is archived, and its aggregate refuses:
  - Ledger asks `IGroupMembers.isArchived(groupId)` (answered by Groups' read model, `GroupMembersOfGroups`) and passes the answer to the aggregate that
    changes the thing: `Expense.register/edit/remove`, `Budget.setAmount/unset`, `SplitTemplate.create/replace/delete`, `Receipt.check`
    (so `attach` and `reattach`), `RecurringExpense.setUp/stop`. The change is refused before anything is stored, and before the file is sent to the
    receipts store.
  - Settlements asks through `SettlementGroup.archived` (`ISettlementMembers.groupOf`, the answer Groups gives its read model) and passes it to the
    book, whose `#decide` and `#decideRefund` refuse. A cash settlement and a payment through the provider are refused before the provider is asked.
  - Groups refuses its own changes in `Group`: `join` (accepting an invitation), `leave`, and `Invitation.issue` (creating an invitation).
- **The background job records nothing.** `recordRecurringDay` answers `idle` for a recurring expense whose group is archived, and so the job steps
  no further on it. The day-came reaction (`RecurringExpenseDayCameHandler`) asks the same question, because it runs in its own transaction after
  the step: a group archived since the step records nothing there either.
- **Reads are unchanged.** Nothing a member reads is refused, and no read answers differently except the `archivedAt` key of the group.
- **The settlement webhook is not refused.** A settlement in an archived group cannot be `pending` or `refunding` (the archiving refuses a group that
  has either), so the webhook has nothing to move there.
- **The API is request 27's** (`api/27-archive-a-group.yaml`): `POST /v1/groups/{id}/archive`, answered `204` or a refusal, and the restated `group`
  resource with `archivedAt`.

## Consequences

- One shared-kernel word, `GroupArchivedException`, that every context refuses with. It is in the shared kernel, not in a context, so the rule's
  name is the same wherever it is raised.
- Ledger's and Settlements' ports each gain one answer (`isArchived`, `archived`); the adapters over Groups' read model answer them. No new port, no new
  link, no new context; `conventions/architecture.yaml` and the context map are unchanged.
- The aggregates that change a thing take the archived fact as a required input, so a use case that forgot to ask would not compile (for
  `Expense`, `Budget`, `SplitTemplate`, `Receipt`, `RecurringExpense` and the settlement book). Each spec passes `archived: false` (or `true` where it tests
  the refusal).
- **A race is accepted, and is recorded here.** The archiving reads each balance and the waiting payments on Ledger's and Settlements' read connections,
  and saves the group under its own version. A change that another context commits between those reads and the archiving's commit is not seen by the
  archiving, so an expense or a settlement could land just before a group is archived with a balance that is not 0. Groups' version check does not
  cover another context's table. Closing it needs the archived check and the balance to be read in the same transaction as the write that moves
  them, which the storm does not ask for.

## When to revisit

When a balance can be read and saved in the same transaction as the change it guards (the race above), when a group must be archived by someone
other than its owner, or when an archived group must be unarchived (the request does not allow it).
