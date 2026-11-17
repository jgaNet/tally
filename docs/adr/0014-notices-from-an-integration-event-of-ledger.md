# 14. Notices come from ExpenseRecorded, Tally's first integration event, through the outbox

## Context

Request 17 tells each member of an expense's split but its payer, soon after the expense is recorded, what it cost them
(`api/17-notices.yaml`): one notice per member, the most recent first, read by its own member only. The storm
(`conventions/storms/notices.yaml`) decided before the code that Notifications learns of an expense from a fact Ledger
publishes, that a reaction makes one notice per member in its own transaction, that edits and deletions are told to nobody,
and that a notice is the person's, whether or not they are still in the group.

Notifications is a context since checkpoint 2 (ADR 9), declared empty, and the relationship Ledger → Notifications was
declared `planned` there (T9). Nothing crossed it until now. The feature therefore brings the first integration event, the
first relationship carried by a published language, and the first aggregate of Notifications.

## Decision

- **The relationship is carried by an integration event, `ExpenseRecorded`**, declared in the published language
  (`conventions/integration-events.yaml`, version 1: the expense's id, its group, its payer, its amount and its shares) and
  published from `SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents.ts`. The relationship's `planned` mark
  is removed from the context map: the code carries it now.
- **Ledger publishes it from a reaction to its own domain event.** `ExpenseRecordedEvent`, recorded by `Expense.register` and
  published after the commit, now carries the shares of the split, which the consumer needs and nothing reads back. A policy
  in Ledger (`ExpenseRecordedHandler`) translates it into the integration event with `publishIntegrationEvent()`, so the fact
  leaves Ledger through the outbox, in a transaction of the reaction's own. Ledger knows nothing of who is told.
- **Notifications reacts to the integration event** through an anti-corruption handler in its wiring
  (`ExpenseRecordedIntegrationEventHandler`): it makes one `Notice` for each share whose member is not the payer, with that
  share's amount, and stores them in one transaction. Each notice is an aggregate root, `Notice`, which records
  `NoticeIssued` on its birth; the handler publishes what it recorded through the outbox.
- **A notice is the member's and nobody else's.** `GetMyNotices` answers the signed-in caller's notices, the most recent first,
  and asks no other context: a notice stays after its member leaves the group, so no membership is checked.
- **Edits and deletions tell nobody.** `ExpenseEdited` and `ExpenseDeleted` stay Ledger's own facts, as the storm decided.
- **Once per member is the bus's, not the handler's.** The reaction is not made idempotent by hand: the bus hands a message
  to each subscriber once per process (ADR 24), and a reaction that fails rolls back its notices and is handed the message again.

## Consequences

- A `NoticeIssued` domain event is recorded and published with no reaction in the application yet. It is kept because the
  storm names it as the fact of a notice's birth, and a later request (the reminders of request 19) may read it. A domain
  event with no reader is the exception the checklist of a Lite context asks an ADR for; this is that ADR.
- The outbox is the process's in-memory one (`createApplication.ts`), as it was for every fact of the application so far.
  A fact the process stops before relaying is lost with it, so a notice can be missed in the moments between the recording
  and its relay; it cannot be made twice, since nothing that survives a restart is re-handed out. A durable outbox written in
  the expense's own transaction closes the gap, and is an architecture change of its own (ADR 24 of the reference).
- Notifications keeps its notices in its own SQLite tables, in the application's database file, as the other contexts do.

## When to revisit

When the outbox is made durable in the same transaction as the expense (the gap above), and at request 19, when reminders
read what members still owe through the port Notifications owns (`OutstandingDebts`, the other planned relationship of ADR 9).
