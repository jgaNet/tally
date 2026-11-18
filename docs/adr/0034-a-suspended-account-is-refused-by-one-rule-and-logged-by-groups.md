# 34. A suspended account is decided by Groups, refused by one rule in every context that starts a change, and logged by Groups

## Context

Request 34 lets an administrator suspend an account and reinstate it. While it is suspended, the expenses, recurring expenses, cash settlements,
provider payments and nettings the account starts are refused, in every group, by the same rule's name; its recurring expenses wait; and
nothing is written in any group. Each suspension and reinstatement is an entry of the administrators' log, which Settlements already keeps
decisions in (request 33, docs/adr/0033). The storm of the feature (conventions/storms/suspend-a-member.yaml) decided where each part lives.

## Decision

- **A suspension is a state of the Account.** `Account.suspend({ by, at })` and `Account.reinstate({ by, at })` change it only when it is not
  already so: each records its event (`AccountSuspended`, `AccountReinstated`) and answers whether it changed. An unchanged suspension records
  nothing, so the log has one entry per change. The aggregate is the only place the flag lives: no context keeps a copy of it.
- **One name for the refusal, in the shared kernel.** `AccountSuspendedException(service)` (SharedKernel/Domain, type `AccountSuspended`) is
  the rule's exception, as `GroupArchivedException` is (docs/adr/0026). Every refusal in the application uses it, so an expense, a recurring
  expense, a cash settlement, a provider payment or a netting refused for a suspended caller says the same name in every context.
- **Each context asks Groups through the port it already owns.** `GroupMembers` (Ledger) and `SettlementMembers` (Settlements) gain
  `isSuspended(accountId)`, answered over Groups' read model (`IGroupQueries.isSuspended`). The use case asks it for the caller, as it asks
  `isArchived`, and passes the answer to the aggregate, which refuses:
  - Ledger: `Expense.register` (a recorded expense) and `RecurringExpense.setUp`, for the caller who is the payer.
  - Settlements: `SettlementBook.recordCash`, `reserveProviderPayment` (the payer is the caller) and `NetDebts.decide` (the caller asks the netting).
  Reading, editing or deleting an expense, leaving a group, refunding or contesting a settlement are not refused: no check is added to them.
  Other members may still put the suspended account in a split and settle with it, because the caller is the one asked, not the members.
- **A recurring expense waits for a suspended payer.** The background job's step (`RecordRecurringDay`) asks `isSuspended(payer)` when the day
  has come, after the archived check, and answers `idle`: nothing is recorded, the day stays next and is not ended. The first run after the
  reinstatement records every day that has come (request 23). A day whose step ran before the suspension is recorded by its reaction, as the
  step decided it: the reaction does not ask again, and the window is one transaction wide.
- **The log is Groups' own, written with the change.** `Account` keeps the entries it made since it was read (`changes`), and the store
  writes each into `administrator_account_changes` in the change's transaction, after the version check. The entry is minted by the aggregate
  (`Id.generate()`), as Settlements mints its decisions'. `GetAdministratorsLog` reads Groups' entries (`IAdministratorChanges`) and Settlements'
  decisions (`IAdministratorDecisions`), and answers both, the oldest first, to an administrator only.
- **Who may suspend.** `SuspendAccount` and `ReinstateAccount` are commands answered at once, to an administrator (`role` ADMIN; `NotAllowed`
  for anyone else, signed in), on the routes `PUT` and `DELETE /v1/admin/accounts/:id/suspension`. A missing account is `NotFound`.
  An anonymous call is refused by the transport with `401`, as every command that needs a caller.
- **No integration event.** Groups' suspension reaches the other contexts through the ports they own, asked at the moment they decide, so a
  change is refused as soon as the suspension is answered. Nothing is written in any group.

## Consequences

- The relationships are unchanged: Groups → Ledger carries `GroupMembers`, Groups → Settlements carries `SettlementMembers`, and
  Settlements → Groups carries `AdministratorDecisions`, now read with Groups' own log. conventions/domain.yaml says so.
- A new column `accounts.suspended` and a new table `administrator_account_changes` are created when the database is prepared, as the accounts
  table was (docs/adr/0029). A database that already holds the schema is not changed by this step: the feature is new, not a migration.
- The administrators' log is not per group, and is never changed or removed by any request.
- A suspended account signs in and reads as before; a token issued before the suspension is not revoked by it. The refusal is at each change,
  not at the sign-in, which is what request 34 asks.

## When to revisit

If a suspension must also end the account's sessions, or hide what it reads, the token check or the read model changes, and this decision says
so. If a suspended payer's recurring expenses must end rather than wait, the job's step changes with the statement of request 23. If the
race between a suspension and a recurring day's reaction matters, the reaction checks the payer too, and the step's day is then skipped, not
lost: that is a new decision.
