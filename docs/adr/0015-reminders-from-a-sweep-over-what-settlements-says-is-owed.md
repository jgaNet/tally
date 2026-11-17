# 15. Reminders come from a sweep of the background job over what Settlements says is still owed

## Context

Request 18 reminds a member who has owed more than 2000 in a group for a week, and again each week while it lasts, at most
once a week whatever the number of servers on the database (`api/18-reminders.yaml`). The storm
(`conventions/storms/reminders.yaml`) decided before the code that the background job notices, never a read; that Notifications
keeps a `DebtWatch` per member and group; that "still owes" comes through a port Notifications owns, answered over Settlements'
read model; and that the optimistic check of the watch is what keeps two servers from reminding twice.

Request 1 names a background job (every `JOBS_INTERVAL_SECONDS` seconds, 60 when not set), but the application had none until now.
The relationship Settlements → Notifications was declared `planned` in ADR 9 (T9).

## Decision

- **A background job exists**, in the composition root (`createApplication.ts`): a timer that does not keep the process alive,
  stops when the application closes, never runs two runs at once in a process, and logs a refused or failed run and goes on. A
  run calls the use case `SweepDebts` of Notifications, in an execution context of its own, with no caller (`{ caller: 'anyone' }`;
  it has no route, so nothing but the job calls it).
- **The relationship is carried by an owned port.** `OutstandingDebts` is Notifications' port; `OutstandingDebtsOfSettlements`
  answers it over `IOutstandingDebtQueries`, Settlements' read model, exported by its wiring. That read model counts what the
  ledger's balances say, with the payments waiting at the provider counted as paid (`stillOwed`, ADR 12), for the members Groups
  says the groups have now. To know them, Groups' read model gains `currentMembers()` and Settlements' `SettlementMembers` port
  `allMembers()`. The `planned` mark is removed from the context map.
- **`DebtWatch` is an aggregate**, held where `several-writers` fires: two servers sweep the same database, so the same watch can
  be read and decided by two at once. It carries the version it was read at; its store saves it conditional on that version, in
  one transaction with the reminder the run made, so a reminder exists exactly once with the watch that says it was made. The run
  that loses gets a `ConcurrencyConflictException`, the use case reads again (three attempts) and finds the member reminded within
  the period, and does nothing.
- **The rules are a decision**, `decideSeeDebt`, a pure function of the watch kept, what the run saw and the run's time: noted from the
  run that sees more than 2000 owed; not noted from the run that sees 2000 or less (or a member who left), the last reminder kept; a
  reminder at a run when the debt has been noted for a period or more and the last reminder is a period or more ago. The period is
  `REMINDER_PERIOD_SECONDS`, 604 800 when not set, read when a run starts. Time is the one clock the wiring passes.
- **A reminder is a notice** of kind `reminder`: a `Notice` with no expense, whose amount is what the member owes at the run. The
  notices table gains a `kind` column (added to a database made by request 17; a reminder's expense is kept as `''`), and
  `GET /v1/notices` answers a reminder with no `expenseId`.
- **Facts.** `DebtNoted`, `DebtCleared` and `ReminderIssued` are recorded by the watch and published after the save, as the storm
  names them. Nothing reacts to them: they stay Notifications' own.

## Consequences

- A read never notes or reminds. Between runs nothing changes; a debt that comes and goes between two runs is never seen.
- A member who leaves a group is not in the debts, so their watch is cleared at the next run; a debt that comes back waits a period
  from the run that sees it, and from the last reminder.
- Domain events with no reader are the exception ADR 14 already took for `NoticeIssued`; this is the same one.
- The outbox is still the process's in-memory one (ADR 14): a published fact can be missed on a crash, a reminder cannot be made twice.

## When to revisit

When a durable outbox exists, and when a request makes a reminder reach a person another way than the notice list.
