# 4. Ledger records an expense, split equally by the members Groups names

## Context

Feature 4 (request 4) lets a member record an expense they paid, split equally between members of the group, the
remainder to the payer. The storm (`conventions/storms/record-an-expense.yaml`) decided three things: Ledger asks Groups
who may be in a split through a port it owns, `GroupMembers`, when it decides (ADR 1, T3); one Expense aggregate per
expense; and the shares are computed once, in a `Split` value the expense is created with.

Building it showed two things the storm did not say, and the Lite profile says a new aggregate, a new domain event and
a new cross-context read come in only by an ADR.

- **The read inside the command's transaction.** A command runs in one transaction, and the unit of work holds the
  file's turn for all of it (`SqliteUnitOfWork.beginTransaction`). Groups' read model reads through `exclusive()`, which
  waits for that same turn. A command that asked it would wait for itself: a deadlock, not a refusal.
- **The aggregate and the event in a Lite context.** The profile holds `aggregates` and `domain-events` out of Lite
  contexts until a trigger fires (`several-writers`, `reacts-to-domain-event`). Ledger's only command does not fire
  either trigger. The storm nevertheless decided one Expense per expense, and Groups already records a fact nothing
  reacts to (`GroupCreated`, feature 2), so the precedent is the same.

## Decision

- **The link is carried, so it is no longer `planned`.** `conventions/domain.yaml` drops `planned: true` from
  Groups → Ledger (`owned-port`, `GroupMembers`), decided here as T3 was in ADR 1. Ledger → Groups (`MemberBalances`,
  T5) stays `planned` until the feature that leaves a group brings it.
- **The port is Ledger's, the answer is Groups' read model.** `IGroupMembers` lives in Ledger's domain
  (`membersOf(callerId, groupId)`: the current members in the order they joined, when the caller is one of them,
  `undefined` otherwise, as if the group did not exist). The adapter `GroupMembersOfGroups` in Ledger's Infrastructure
  implements it over Groups' `IGroupQueries`, and Ledger's wiring receives that read model from Groups' wiring file,
  which exports it for this purpose.
- **A read of another context's read model inside a command runs on a connection of its own.** Groups' wiring
  exports `groupsReadModel`, a `SqliteGroupQueries` over its own `SqliteDatabase` (the same file, a second connection
  and a second turn). In WAL mode it reads what is committed and never waits for the writer's transaction. A
  membership is committed before a request that depends on it, so nothing a split needs is missed. The shared
  connection's own reads are unchanged. The cost: the read is a snapshot taken at the read, not inside the writer's
  transaction; a member leaving in the same instant could be read as still a member. Leaving is a later feature
  (request 20, ADR 1's known gap T5), so it is recorded here, not closed.
- **One Expense aggregate, with a `Split` value.** `Expense.register()` (the creation, named as Groups' `Group.register()`)
  validates the description (1 to 100 characters, not only spaces), the amount (an integer from 1 to 100 000 000), the
  date (a real day of the calendar, not after today in UTC, from the one clock) and the split, generates the id, and
  records `ExpenseRecorded`. `Split.equally()` refuses a split with a member listed twice, a split with someone who is
  not a current member, or one without its payer; it computes each share as the amount divided by the number of members,
  rounded down, and gives the remainder whole to the payer. The shares are kept with the expense, in the order the split
  was given. `fromSnapshot()` reads what the store kept and throws if its shares do not add up to its amount.
- **A non-member does not see the group.** A caller who is not a member of the group is refused with the group's
  `NotFound`, on the record (`RecordExpense`) and on the read (`GetExpense`), the same as a group the caller is not in.
- **Domain event, no integration event.** `ExpenseRecorded` is a domain event, published by the command's
  `publishDomainEvents` after the commit; nothing in another context reacts to it, so `conventions/integration-events.yaml`
  stays empty. The balances (request 5) will read Ledger's own facts when they arrive.
- **Routes at the root.** Ledger serves two resources, so its routes mount at the API's root with their full paths
  (ADR 3, its consequences): `POST /groups/:id/expenses` and `GET /expenses/:id`.

## Consequences

- Ledger's store is two tables in the application's file (`expenses`, `expense_shares`), registered with the database
  as Groups' are. A stored expense is never changed by this feature; a save of one already stored is refused by the
  store, not silently written.
- The storm's expectation (`conventions/storms/record-an-expense.yaml`) is met by the code and marked done by the gate.
- The `GroupMembers` link is declared and carried, so the conventions check fails if the import goes away while the
  map still says it exists, and the reverse.

## Alternatives

- **Call Groups' read model on the shared connection.** It deadlocks, as above. Not taken.
- **Make the shared database's reads reentrant within a transaction.** A read by another request would then run on the
  connection with the writer's uncommitted rows. Not taken.
- **Ask Groups' write-side repository inside the transaction.** It sees the transaction's own rows, but it is not the
  read model the storm decided on (ADR 1, T3), and it would hand Ledger Groups' aggregate. Not taken.

## When to revisit

When request 20 (leaving a group) makes a member's balance a reason to refuse, and Ledger → Groups (`MemberBalances`)
is carried: then the read that decides a leave needs the same answer under a transaction, and this decision's snapshot
gap is closed or declared then. Also when Groups gains a second writer of membership, which would make the snapshot
read a conflict to refuse rather than a race to tolerate.
