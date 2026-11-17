# 18. A debt that lasts is reminded by Notifications' sweep, which reads what is owed from Settlements

## Context

Request 18: a member of a group who still owes more than 2000 in it is reminded once that has lasted a week, and again each week while it
lasts. Only current members are reminded. The background job looks at what every member of every group still owes at each run; a read
notes and reminds nobody; a reminder is a notice of its own kind with no expense; and a member is reminded at most once a period, however
many servers share the database. The storm (`conventions/storms/reminders.yaml`) decided that the sweep runs in Notifications, that it keeps
a watch per member and group, that what is owed comes from Settlements through a port Notifications owns (`OutstandingDebts`), and that the
watch's optimistic check holds the period across servers.

## Decision

- **The sweep is Notifications' background job.** The composition root runs it at every `JOBS_INTERVAL_SECONDS`, next to the outbox's
  relay (`REMINDER_PERIOD_SECONDS`, 604800 when unset, is the period). Each member is decided on in its own transaction by `SweepDebt`, a
  command with the one clock's now as its time; a debt is never noted or reminded by a read.
- **What is owed is Settlements' answer, through Notifications' own port.** `IOutstandingDebts` (Notifications' Domain) is answered by
  `OutstandingDebtsOfSettlements` in Notifications' Infrastructure, which translates Settlements' `IOutstandingDebtQueries`. Settlements
  answers it with `OutstandingDebtsOfLedger`: each group's balances (Ledger, through Settlements' own `IGroupBalances`) less the payments
  waiting at the provider, as `stillBalance` counts them. A member who leaves has left at 0 (ADR 0009), so only current members owe.
- **Notifications cannot import Ledger**, so the composition root opens the Settlements' adapter over Ledger's and Settlements' read models,
  as it opens the other cross-context read models (ADR 0009). `IGroupBalances` and `IExpenseQueries` each gain `groupIds()`, the groups
  that have an expense: a group with none owes nothing, so the sweep reads every group that could owe.
- **A `DebtWatch` per member and group** is the sweep's memory: `notedSince` (the run that first saw more than 2000) and `lastRemindedAt`.
  `sweep()` is a step of the watch at the run's time: a debt over 2000 not yet noted is noted (`DebtNoted`); a noted one that has lasted a
  period and was not reminded in the last period is reminded (`ReminderIssued`, with a `Notice` of kind `reminder`); a debt of 2000 or less
  that was noted is cleared (`DebtCleared`). A debt that comes back is noted from the run that sees it; the last reminder is kept, so it
  waits a period from there too. The watch is saved at the version it was read at (CONC-OPTIMISTIC); the run that loses re-reads, finds the
  member reminded within the period, and does nothing.
- **A reminder is a notice without an expense.** `Notice.remind()` makes it with kind `reminder`; the `expense_id` column is nullable,
  so the one table keeps both kinds, and `GET /v1/notices` omits `expenseId` for a reminder.
- **The storm's link is carried**, so the context map's Settlements → Notifications relationship is no longer `planned`.

## Consequences

- A debt that a payment settles clears at the next sweep, not at the payment: the sweep reads what is owed, and it is read at a run.
- The sweep reads every group's balances at each run. That costs one read per group with an expense, every interval; it is the price of
  not keeping a second copy of the balances in Notifications.
- A database created before this request has a `notices` table whose `expense_id` is `NOT NULL`: a reminder cannot be stored in it until
  that table is rebuilt. The schema is created with `CREATE TABLE IF NOT EXISTS` and has no migrations yet; this is the cost, and it is
  paid where the database is first made.

## When to revisit

When the sweep's read of every group is too heavy for the number of groups (then Settlements keeps the debts of each group as they change,
and the sweep reads only those); and when a reminder is delivered elsewhere (email, push), which would give the notice a delivery of its own.
