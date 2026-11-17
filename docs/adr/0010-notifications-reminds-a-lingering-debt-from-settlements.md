# 10. Notifications reminds a lingering debt, from a sweep that asks Settlements what is still owed (the Settlements → Notifications link, carried)

## Context

ADR 6 declared the Settlements → Notifications relationship, `planned`, and decided (T9) that a reminder is for a debt that
lasts, and that only Settlements knows what each member still owes once the paid settlements count. Request 18 (reminders)
is the feature that carries it. Its storm, `reminders`, decided the hot spots with the product's owner: the background job
(`JOBS_INTERVAL_SECONDS`) is the one that notices a debt has lasted, never a read; Notifications keeps, per member and group,
since which run the member has been seen to owe more than 2000 and when they were last reminded; "still owes" comes from
Settlements through a port Notifications owns, counting the payments waiting at the provider as paid; two servers on one
database cannot remind twice in a period; and a reminder is a notice of kind `reminder`, with no expense.

Two things the code did not have: a read of every current member of every group (Groups answered only per caller), and
a read of what each member still owes that counts the waiting payments (Settlements answered the balances and the waiting
payments separately, and Ledger counts only the paid ones).

## Decision

- **The sweep is a job of Notifications** (`RemindLingeringDebtsJob`, `Application/Jobs`). The composition root schedules
  it every `JOBS_INTERVAL_SECONDS`, after the outbox relay, with the period `REMINDER_PERIOD_SECONDS` (604 800 when unset).
  It takes the application's clock once per run and hands the instant to the aggregate as a parameter. It reads nothing on
  behalf of a person: a read answers what is kept.
- **Settlements answers what each member still owes.** `IOutstandingDebtQueries` (Settlements' Domain, a read-model port)
  is answered by `SettlementsOutstandingDebtQueries` (Settlements' Infrastructure): each current member of every group,
  their balance as Ledger counts it (`IGroupBalances`, which already counts the paid settlements, ADR 8), less the payments
  waiting at the provider (`ISettlementQueries.waitingIn`), counted as paid. The arithmetic is a pure function of the
  domain (`stillOwed`). A member who owes nothing is not listed.
- **Groups answers every current member of every group** (`IGroupQueries.membersOfEveryGroup`), a read that names no caller.
  It is for the background job only; the other reads keep their membership check.
- **Notifications asks through a port it owns** (`IOutstandingDebts`, `Notifications/Domain/DebtWatch/Ports`), answered by
  `SettlementsOutstandingDebts` in Notifications' Infrastructure over Settlements' read-model port. The link is the one
  declared since ADR 6; the adapter lives on the asking side, as ADR 7 decided for the others.
- **A `DebtWatch` is the aggregate per member and group** that keeps the two facts the rule needs: `notedSince` (the run
  that first saw more than 2000 owed; cleared by a run that sees 2000 or less) and `lastReminded`. It is kept after a
  clear, so a debt that comes back waits a period from the run that sees it and is not reminded twice in a period. It
  records `DebtNoted`, `DebtCleared` and `ReminderIssued`; it decides with `observe(owes, at, period)`, which says whether
  a reminder is owed, and nothing else.
- **A reminder is a `Notice` of kind `reminder`**, made in the same transaction as the watch's change: its recipient, its
  group, the amount still owed (more than 2000) and the instant. It has no expense. `expenseId` is absent from its answer
  (request 18 restates the notice resource).
- **Two servers, one database:** the watch is saved at its version (CONC-OPTIMISTIC). A run that loses the race gets a
  ConcurrencyConflictException, reads the watch again in a new transaction and decides again, up to three attempts; the
  winner's `lastReminded` is then within the period, so the loser reminds nothing.
- **A run decides per member, each in its own transaction**, so one member's refusal does not stop the others: a failed
  member is logged and the next run tries again.

## Consequences

- Reading the balances for the sweep counts every group's members, which is one read per group per run. It is proportional
  to the groups Tally holds; a larger deployment would keep the sums in a read model instead, which this decision does not
  need yet.
- The `notices` table now holds reminders, whose `expense_id` is NULL; the expense's uniqueness stays for expenses, and a
  reminder's uniqueness is the watch's version. A database file made before request 18 keeps its old table definition, so it
  must be recreated; the application has no migrations yet.
- The context map now carries five relationships: the Settlements → Notifications link is no longer `planned`.

## When to revisit

When the sweep's sums need to be read in one place for many groups (a read model of the outstanding debts, kept by the
ledger and the settlements), or when a reminder is sent to someone other than the member who owes (a payee or an
administrator), which would be a new decision of the storm, not a change here.
