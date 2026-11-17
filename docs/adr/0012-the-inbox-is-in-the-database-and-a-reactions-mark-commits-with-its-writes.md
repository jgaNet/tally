# 12. The inbox is in the database, and a reaction's mark commits with its writes

## Context

Request 17 of Tally (one notice to each member of an expense's split but its payer, one per member even when the server stops and
starts again while the expense's fact is still pending) was stormed before the code (`conventions/storms/notices.yaml`, decided with
the product's owner). Its second hot spot names the mechanism: the outbox and the bus's idempotent delivery carry the fact once to
the reaction, and the reaction is never made idempotent by hand.

The contract says the bus delivers a message it already delivered once only, by the outbox entry's id (`kept inbox`, Lite). The code
kept that in `InMemoryEventBus`, in process memory: an entry the relay hands out is acknowledged only after its reaction commits, so a
server that stops in between leaves the entry pending, and a new server starts with an empty inbox and hands the reaction the same fact
again. A reaction that creates one notice per member would then create them twice. The guarantee held for the life of one process only,
and the feature must hold it across restarts.

The building blocks are the architecture's, so this change is an architecture task (`architecture mode architecture`): it changes
`src/Architecture`, and nothing that is not a building block.

## Decision

- **The inbox is a store the unit of work carries, as the outbox is** (`UnitOfWork.inbox`, `Application/Inbox.ts`). Over SQLite it is
  the table `inbox (subscription, message_id)` in the same file as the outbox (`SqliteInbox`); in memory it is an `InMemoryDataSource`
  the in-memory unit of work snapshots and restores with the others (`InMemoryInbox`).
- **A reaction checks and marks the inbox inside its own transaction** (`EventHandler.handle()`). `has()` first: when the subscription
  already handled the message in a committed transaction, nothing runs and the message is answered as handled. Otherwise the reaction
  runs, and `record()` is its last step before the commit, so the mark and the reaction's writes are durable together or not at all.
  A reaction that fails leaves no mark, and the fact is handed to it again.
- **A subscription is named by the handler's class and the event's name** (`NoticesForExpenseHandler:ExpenseRecordedIntegrationEvent`).
  Both survive a restart. Two instances of one class on one event share their inbox, which no handler here needs; one that must differ
  takes its own class.
- **The bus's process-local inbox stays**, as the fast path within one process. It is no longer the only record of what was handled.

## Consequences

- A reaction is handed each message once per subscription, across restarts, and its writes happen once. `SqliteInbox.spec.ts` shows a
  fact handed out again on a new database connection is not handled twice, and that a failed reaction is handled when it is handed out
  again; `notices.routes.e2e.spec.ts` replays an acknowledgement that never landed, against the database file of a stopped server.
- The inbox grows by one row per handled message. Rows are not pruned yet.
- A context without a unit of work (a unit spec's fake) has only the process's inbox; its reactions are not run against a database.

## When to revisit

When a reaction must act outside the database's transaction (a mail, a payment), its mark cannot commit with its effect, and that
reaction must be idempotent by a key of its own. Also when the inbox table is large enough to matter: rows can then be pruned once the
outbox no longer holds their message.
