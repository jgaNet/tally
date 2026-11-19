# 32. Suspending an account: Groups decides it and keeps the flag, each context asks through its port and refuses by `AccountSuspended`

## Context

Request 34 (`api/34-suspend-a-member.yaml`) lets an administrator suspend an account and reinstate it. While it is suspended, the account may not, in any
group, record an expense (requests 4 and 21), set up a recurring expense (request 23), record a settlement in cash (request 12), ask to pay through the
provider (request 13) or ask for a netting (request 32). Each is refused by the name of one rule, the same for all of them, and changes nothing. Everything
else goes on: signing in, reading, editing or deleting an expense, leaving, refunding or contesting a settlement; the others of its groups may still put it
in a split, record its payment to them in cash, or pay it through the provider. The background job records no expense for a recurring expense whose payer is
suspended, and its days wait for the reinstatement. A suspension or its end writes nothing in any group, and each change is an entry of the administrators'
log (request 33) with its `action` `suspended` or `reinstated`.

The storm (`conventions/storms/suspend-a-member.yaml`) was decided before the code. It asked for the same shape as the archive (ADR 24): the decision and its
flag on the aggregate that owns it, a word of the shared kernel as the rule's name, and each context asking Groups through a port it already owns. It
declares the three relationships it needs (Groups → Ledger, Groups → Settlements and Settlements → Groups) as already carried, so the context map is unchanged.

## Decision

- **Groups decides a suspension, and keeps the flag.** `Account` gets `suspendedAt`, set by `Account.suspend(at)` and cleared by `Account.reinstate(at)`,
  which record `AccountSuspended` and `AccountReinstated` (domain events of Groups, with no subscriber: the other contexts ask, they are not told). The flag is
  stored on the accounts' row (an additive column, `NULL` while the account is not suspended).
- **The rules are a pure decision** (`Account.decision.ts`): `decideSuspendAccount` and `decideReinstateAccount` refuse a caller who is not an administrator
  (`NotAllowed`, 403) and an account that is not there (`NotFound`, 404). An account already in the state asked for changes nothing and answers no entry;
  otherwise the decision answers the `AdministratorLogEntry` the change is logged by, and the use case writes the change and the entry in one transaction.
  The entry's id is born in the domain (`AdministratorLogEntry.of`), as an aggregate's is (DOMAIN-IDENTITY).
- **The account is saved at the version it was read at.** `Account` carries its version, as `Group` does, and `SqliteAccounts.save` refuses a newer one with
  `ConcurrencyConflictException` (CONC-OPTIMISTIC); the command re-reads and re-decides up to three times.
- **One rule's name, in one place.** `AccountSuspendedException` (`type: 'AccountSuspended'`) is a word of the shared kernel
  (`SharedKernel/Domain/AccountSuspended.ts`), as `GroupArchivedException` is, so every context names the refusal the same way.
- **Each context asks Groups through the port it owns, and refuses in its decision.** Ledger's `IGroupMembers` and Settlements' `ISettlementMembers` gain one
  question, `suspendedOf(accountId)`, answered by the adapter over Groups' read model, which reads the flag on the accounts' row (`IGroupQueries.suspendedOf`).
  The use case asks it about the account that asks (the payer of an expense or a recurring expense, the payee of a cash settlement, the payer of one through the
  provider, the asker of a netting) and passes the answer into the decision as a given fact (`suspended`). Each decision checks it first, before its shape and
  its balances, so the refusal is the one rule whatever else is wrong. No context keeps a copy of the flag.
- **The recurring expenses wait.** `decideSweepRecurringExpense` decides no day for a recurring expense whose payer is suspended, so the sweep moves no `next`
  and records no expense; at the first run after the reinstatement every day that has come is recorded (request 23). Stopping a recurring expense, and
  every edit or deletion, is not refused.
- **The log.** Groups writes its own entries with the change, in its table `account_administrator_log` (its name is its own: the contexts share one database,
  and Settlements keeps `administrator_log`). `GetAdministratorsLog` answers Settlements' decisions (`IAdministratorDecisions`) and Groups' entries together,
  the oldest first.
- **Answers.** `PUT /admin/accounts/{id}/suspension` and `DELETE /admin/accounts/{id}/suspension` answer `204` at once, for a change or for no change; a caller
  who is not signed in gets `401`, one who is not an administrator `403`, an account that is not there `404`. A refusal of an expense, a recurring expense, a
  cash settlement, a provider payment or a netting answers `400` with `AccountSuspended`.

## Consequences

- The suspension and its entry are in one transaction of the accounts' store. The check of the flag in another context and the change it refuses are in two
  stores, so a change that reads "not suspended" while a suspension is between its check and its commit can be recorded after it. This is the window ADR 24
  accepted for an archive, and it is kept, not solved here.
- A suspension that lands between the sweep's decision of a day and the recording of that day's expense ends the day without an expense (the handler checks the
  flag, as it checks the archive), so that day is not recorded later. This is the one case where a day does not wait; the handler's check is what keeps a
  suspended payer from being recorded in that window, and the lost day is the cost. It is narrow and known.
- A netting refuses only the asker. The other member of a netting is not refused for being suspended: request 34 names what the suspended account starts, not
  what it is owed or is paid.
- Every decision that records a change in Ledger or Settlements takes `suspended` among its given facts, so a test that builds those facts must say
  `suspended: false`, as the archive changed the facts to say `archived`.

## When to revisit

When the contexts' stores can share one transaction (the window above closes), or when a suspension gains an end date or a reason, which would make
`suspendedAt` a state with more than one value.
