# 12. Reminders: a background sweep keeps a debt watch per member, and Settlements answers what is still owed

## Context

Request 18 reminds a member who still owes more than 2000 in a group, once a period that has lasted, and again each period while it
lasts; a debt of 2000 or less is not reminded. ADR 5 declared Settlements → Notifications as a `planned` link for it, and the storm
(`conventions/storms/reminders.yaml`) decided the hot spots before the run: the sweep is a background job of Notifications, never a
read; it keeps a DebtWatch per member and group; what is still owed comes from Settlements through a port Notifications owns
(OutstandingDebts), counting the payments waiting at the provider as paid; the two servers meet an optimistic check; and a reminder is
a notice of its own kind.

The application had no background job yet (request 1 names one, `JOBS_INTERVAL_SECONDS`), and no group enumeration: no port listed the
groups, only the members of one.

## Decision

- **The link is carried, so it is no longer `planned`.** Settlements → Notifications (`owned-port`) loses its flag in
  `conventions/domain.yaml`. Its contract is OutstandingDebts, owned by Notifications, answered by `SettlementsOutstandingDebts`
  (Notifications' Infrastructure) over Settlements' `IMemberDebts`, which Settlements' wiring exports as `memberDebtsWith`. No
  published event is added: a reminder is Notifications' own fact.
- **Settlements answers who still owes what.** `IMemberDebts` (Settlements' Domain) is read group by group from its own ports: the
  balances Ledger has, the payments waiting at the provider (counted as paid, as the suggestions count them) and the current
  members Groups lists. Only members who owe something are in the answer.
- **Groups are enumerated through the balance read side.** `groupIds()` is added to Ledger's `IGroupBalanceSums` and, through
  Settlements' `IGroupBalances`, to Settlements' port. A group with no balance entry has no debt, so every debt is reached. No
  context gains a new relationship for this: the read goes over the port Settlements already owns.
- **The sweep is a job, not a request.** `SweepDebtsJob` (Notifications' Application) runs once per tick. The composition root builds
  it with the clock it passes (`createApplication({ clock })`, the system clock by default), the reminder period
  (`REMINDER_PERIOD_SECONDS`, a week by default) and the debts from Settlements, and registers it on the application with its interval
  (`JOBS_INTERVAL_SECONDS`, 60 by default). The application runs registered jobs on those intervals while it serves, and `runJobs()`
  runs them once, which is how a test moves a week without waiting for one. Nothing reads the machine's time.
- **A DebtWatch per member and group** (`DebtWatch`, Notifications' Domain). It keeps since which run the member has been seen over the
  threshold (`notedSince`) and when it was last reminded. A run that sees 2000 or less clears the noting and keeps the last reminder,
  so a debt that comes back is noted from the run that sees it and waits a period from there. A reminder is due when the debt has been
  noted for a period and no reminder was made in the last one. `DebtWatch.create()` records DebtNoted; `observe()` records DebtNoted,
  DebtCleared or ReminderIssued, and says whether the watch changed or a reminder is due. A member noted but no longer owing anything
  (a member who left, too) is seen at 0, so the noting ends.
- **A reminder is a notice of its own kind.** `Notice.createReminder()` makes a `reminder` notice with the amount still owed (more than
  2000), and no expense. The sweep makes it in the same transaction as the watch that says so, so the reminder and its period are kept
  together or not at all. Its `expense_id` is NULL; the table of notices is rebuilt once for a file made by request 17, which could not
  store it.
- **Two servers, one database.** Each member is decided in a transaction of its own. The watch is stored with a version, and a save
  stores version + 1 only where the stored version is the one read; a run that loses re-reads and re-decides, up to three attempts
  (`CONFLICT_ATTEMPTS`), and finds the member reminded within the period.

## Consequences

- A debt is noted only by a run, never by a read: `GET /v1/notices` changes nothing.
- A reminder waits for the run that is a week after the noting, so with a one-minute interval it arrives within a minute of the
  week's end.
- Each member is read once per run: a run with many debtors opens one transaction per debtor. The balance and the waiting payments
  are read on two separate reads, so a settlement decided between them can show for one run; the next run corrects it, and a
  reminder is never made twice in a period.
- A reminder's amount is what was owed at the run that makes it, not what it was when noted.

## When to revisit

When the sweep has to be sharded across servers (then the job's member set needs a claim, not only the watch's version), when a
member should be reminded of a debt in a currency other than the group's (the threshold is in the group's minor unit), or when a
reminder must be read as read or unread.
