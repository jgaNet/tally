# 25. An account is suspended by an administrator on the Account in Groups, and what a suspended account starts is refused by one name, decided by each context through the port it owns

## Context

Request 34 lets an administrator suspend an account while it is looked into, and reinstate it. A suspended account can still sign in, read,
edit or delete an expense, leave a group, and refund or contest a settlement; it cannot record an expense (requests 4 and 21), set up a
recurring expense (request 23), record a settlement in cash (request 12), ask to pay through the provider (request 13), or ask for a netting
(request 32). The other members of its groups go on as before, and a recurring expense whose payer is suspended waits: the first run after
the reinstatement records every day that has come. A suspension, or its end, writes nothing in any group, and each change is an entry of the
administrators' log (request 33).

The storm (`conventions/storms/suspend-a-member.yaml`) decided four things: where a suspension is, how Ledger and Settlements refuse by one name,
how the recurring sweep waits, and where the log is written and read. This ADR records the one architecture change the storm adds: a word of the
shared kernel, `AccountSuspended`, and the choices the code rests on. It adds no context and no relationship: the three links it uses are already
in the context map (ADR 4, ADR 5, ADR 24), and the map does not change.

## Decision

- **A suspension is a state of the Account, in Groups.** `Account.suspend(now)` and `Account.reinstate(now)` change it and record
  `AccountSuspended` or `AccountReinstated`; each returns whether it changed. An account already in the state asked for changes nothing and
  records nothing, so the log has one entry per change. The account keeps `suspendedAt` in the accounts table; it is kept by the account, so
  Groups is the only context that holds the fact.
- **Only an administrator suspends or reinstates.** The commands `SuspendAccount` and `ReinstateAccount` refuse a caller who is not an
  administrator in `guard()` (`NotAllowed`), as `DecideContest` does (ADR 24). The administrator's id is the caller's, and the change is written
  in the administrators' log in the command's transaction, with the change.
- **The one refusal is a word of the shared kernel, `AccountSuspended`.** It is `src/SharedKernel/Domain/AccountSuspended.ts`, an `Exception`
  whose type is `AccountSuspended`, beside `GroupArchived` (ADR 18). The shared kernel is the place for the words every context agrees on, so
  the refusal is named once. This is the architecture change: the shared kernel gains one word, and the feature mode refuses that, so the change
  runs under the architecture mode and is recorded here.
- **Each context asks Groups through the port it already owns, and keeps no copy of the fact.** Ledger reads `suspendedOf` through its
  `IGroupMembers`, and Settlements reads `suspendedOf` through its `ISettlementMembers`; both are answered by an adapter over Groups' read model,
  `isSuspendedOf`, read inside the command's transaction and taking no lock, as `archivedOf` is (ADR 18). The caller is the account that starts
  the change: the recorder of an expense, the setter of a recurring expense, the payee of a cash settlement, the payer of a settlement through the
  provider, and the caller of a netting.
- **Each aggregate refuses before anything else it checks, by the one name.** `Expense.create`, `RecurringExpense.setUp`, `RecurringExpense.recordDay`
  and `SettlementBook`'s `decide` take a `suspended` flag and refuse with `AccountSuspended`, after `GroupArchived`. A netting asks once and passes the
  flag into every book it decides in.
- **The recurring sweep waits, it does not fail.** `RecurringExpense.recordDay` refuses a suspended payer with `AccountSuspended`, the sweep
  ends that run without reporting it, as it does for an archived group (ADR 18), and the day stays next: the first run after the reinstatement
  records every day that has come.
- **The administrators' log is one log, read from two places.** Groups writes its own entries (`administrator_log_entries`), with the suspension
  or the reinstatement, in the command's transaction. Groups' port `IAdministratorDecisions` is answered by an adapter that merges Groups' entries
  with Settlements' read model (request 33, ADR 24) and sorts them by time, the oldest first. Groups reads Settlements' log through the port it owns,
  as before; the merge is in Groups' infrastructure, so no context imports another's domain.

## Consequences

- A suspended payer's recurring expense that was decided before its suspension and whose expense reacts after it is refused by the expense's own
  creation, as an archived group's is (ADR 18): the reaction fails and the expense is not recorded. The sweep prevents this in the ordinary case,
  because it decides a day only while the payer is not suspended; the window between the day's decision and its reaction is the one case left.
- The accounts table gains `suspended_at`. A database made before this change has no such column, and must be brought up to date when it is opened
  (as ADR 30 does for other columns); a fresh database is made with it.
- The administrators' log now has `suspended` and `reinstated` entries, and the route `GET /v1/admin/log` answers them. Its order is the time each
  was decided, oldest first; an entry of Settlements and an entry of Groups never share an id, so no entry is lost in the merge.
- The API answers the two routes `PUT` and `DELETE /v1/admin/accounts/{id}/suspension` with `202`, read at the operation, and the operation of a
  refused caller is `NotAllowed`, as the other administrator commands answer.

## When to revisit

If a suspended account should be refused more (leaving a group, a signed-in reading that is hidden, a payout account), that is a new request and a
new rule: each refusal is one more `suspended` flag asked of the port and one more aggregate check, and the shared kernel's word is the one name.
If an administrator should be able to act on a suspended account's money in a group (a correction, for instance), that is a new decision, not a
change to this one.
