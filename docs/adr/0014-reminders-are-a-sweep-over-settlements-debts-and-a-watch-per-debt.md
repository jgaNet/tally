# 14. Reminders are a sweep in Notifications over Settlements' debts, and a watch per member and group

## Context

Request 18 of Tally (a member who still owes more than 2000 in a group is reminded once it has lasted a week, and again each week
while it lasts; only current members; at most once a week per member and group, whatever the servers) was stormed before the code
(`conventions/storms/reminders.yaml`, decided with the product's owner). ADR 8 declared the relationship Settlements → Notifications as
an owned port, `planned`, so that Notifications asks Settlements what each member still owes without Settlements knowing who is reminded.

Nothing in the application runs on a timer yet, and a read must never note or remind anybody: a debt that lasts is found only by a run
that looks at it. The Lite profile's rules hold where their triggers fire, so the new aggregate, the new events and the new job are
decided here, as ADR 13 decided the notices.

## Decision

- **The sweep is a use case of Notifications, run by the composition root** every `JOBS_INTERVAL_SECONDS` (60 when not set). The
  composition root starts it with `FastifyApplication.every`, which runs a job from `start()` until `stop()` and does not start a run
  while the last is still going; the job gets the one clock the wiring passes (DOMAIN-ONE-CLOCK) and the reminder period
  (`REMINDER_PERIOD_SECONDS`, a week when not set) as a parameter. It is a command, so a conflict re-reads and re-decides it in a new
  transaction, up to three attempts (CONFLICT_ATTEMPTS).
- **A `DebtWatch` is an aggregate per member and group** (the storm's DebtWatch): since which run it has seen the member owe more than
  2000 (`notedAt`), and when it last reminded them (`lastReminderAt`, kept through a clearing). It records DebtNoted, DebtCleared and
  ReminderIssued, and is saved over the version it was read at (CONC-OPTIMISTIC): of two servers sweeping one database, the one that
  loses re-reads and finds the member reminded within the period. Its rules are pure: the time and the period are given.
- **A reminder is a notice of its own kind** (`Notice.reminder`), with no expense: `notices.expense_id` is nullable, and a reminder's
  view names no `expenseId`. The notice's `NoticeIssued` is recorded as any notice's is.
- **"Still owes" comes from Settlements' read model, over an owned port.** Notifications owns `IOutstandingDebts`, asking in its own words;
  `DebtsFromSettlements` is its adapter over Settlements' `IDebtRoster`, a port in Settlements' Domain, answered by
  `OutstandingDebtRoster`. That roster opens each group's book as a settlement is decided against it (`openBook`): its current members,
  the balances the ledger counts, and the payments waiting at the provider counted as paid, as the storm decided. The declared link is no
  longer `planned`, since the code carries it through the adapter's import.
- **The sweep reads every group**, so Groups' roster gains `groupIds()`, the ids of every group, earliest first. Ledger and Settlements
  read the roster through the same port as before, so nothing else changes.
- **No migration.** The new table `debt_watches` and the nullable `expense_id` are created by `CREATE TABLE IF NOT EXISTS`, as every
  table of this application is; a database made before this request is made again.

## Consequences

- A member who owes 2000 or less is cleared at the next run, and a debt that comes back is noted from the run that sees it: its
  reminder waits a period from there, and not less than a period from the last reminder.
- The sweep is the only writer of a watch, so a read never changes what is kept. What a read of balances (request 5) shows does not
  count a waiting payment; what the sweep reads does, as the storm decided, so a member whose payment is waiting at the provider is not
  reminded for it.
- A member who leaves a group is not in the read model, so their watch is cleared at the next run.
- Each run reads every watch and every current member's debt: fine at this application's size, and the first thing to index if it grows.

## When to revisit

When the sweep's cost grows with the groups (a read of only the groups a debt changed in), and if reminders are asked to go to someone
other than the member (an organiser, say), which would be a second decision about who is reminded.
