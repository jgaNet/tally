# 10. The background sweep keeps each debt through an owned port, and a reminder is kept once a week per member and group

## Context

Request 18 reminds a member who has owed more than 2000 in a group for a week, and again each week while the debt lasts. Nothing
is noted or reminded because someone read something, so a debt is noticed by the background job, every `JOBS_INTERVAL_SECONDS`.
The storm for the feature (`conventions/storms/reminders.yaml`) decided who notices a debt (the sweep, in Notifications, never a
read), what Notifications keeps, where "still owes" comes from, how two servers on one database keep a reminder to one a week, and
that a reminder is a notice. ADR 5 had declared the link from Settlements to Notifications `planned`, decided before the code that
carries it: this ADR makes it real.

## Decision

- **Notifications owns the port `OutstandingDebts`** (`IOutstandingDebts`, T9 of the storm): what each current member of each group
  still owes, in amounts above 0. Its adapter (`OutstandingDebtsFromSettlements`) reads Settlements' read model, exported from its
  wiring the way Ledger's and Groups' read models are, so Notifications never imports Settlements' Application or Infrastructure.
- **Settlements answers it over its read model** (`OutstandingDebtsReadModel`): each member's balance as Ledger counts it, plus the
  payments waiting at the provider, as the suggestions count them, for the members Groups says are current. Settlements gets the
  groups and their current members through its own port `ISettlementMembers.groupsWithMembers`, answered over Groups' read model.
  The context map declares the link `owned-port`, Settlements → Notifications, and it is no longer `planned`.
- **A `DebtWatch` per member and group** is the aggregate the sweep keeps (T7): `since`, the run that first saw the member owe more
  than 2000, and `lastReminded`. A run that sees 2000 or less clears `since` and keeps `lastReminded`, so a debt that comes back
  waits a period from the run that sees it. Its facts are `DebtNoted`, `DebtCleared` and `ReminderIssued`.
- **The sweep is a job** (`DebtSweepJob`), started by the process entry point on `JOBS_INTERVAL_SECONDS` (60 when unset), not by
  `createApplication`, so a test builds the application without a timer. It takes the clock from the wiring (DOMAIN-ONE-CLOCK).
  Each run reads the debts, then decides each watch it sees owing or noted in a transaction of its own.
- **Two servers, one database** (T8): a watch is saved at the version it was read at. The server that loses gets a
  `ConcurrencyConflictException`, reads the watch again, and finds it reminded within the period; three attempts at most, and the
  last conflict is logged and left for the next run.
- **A reminder is a notice of kind `reminder`** (T10): `ReminderIssued` is reacted to in Notifications, in the reaction's own
  transaction, by making a `Notice` with no expense and the owed amount. The API answers it without `expenseId`.
- **The period is `REMINDER_PERIOD_SECONDS`**, 604800 when unset, read by Notifications' wiring.

## Consequences

- A reminder can be a little late: the sweep runs every `JOBS_INTERVAL_SECONDS`, and the amount is what was owed when the sweep read
  the debts, not at the instant the reminder is kept.
- A member who leaves a group is no longer answered by the port, so the sweep clears their watch and no reminder is made for them.
- The `notices` table changes shape: `kind` is added and `expense_id` may be null. A file made before reminders is rebuilt in place
  at start, keeping each notice and its order; no notice is lost.
- Settlements' read model now reads every group's members. It takes no lock of its own, as the suggestions do not.

## When to revisit

If the sweep needs Ledger's balances rather than Settlements' answer (a debt that counts no settlement), or if a reminder must be
sent in the instant a debt is noticed rather than at the next sweep, a second published fact or a second port is decided in a new ADR.
