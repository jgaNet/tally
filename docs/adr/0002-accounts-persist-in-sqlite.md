# 2. Accounts persist in SQLite, over one file that every server shares

## Context

The reference's building blocks keep everything in memory: `InMemoryDataSource`, `InMemoryUnitOfWork`, `InMemoryOutbox`.
Request 1 of Tally asks that a server stopped abruptly and started again on the same file finds every account and
every request afterwards, and that several servers may run on that file at the same time. Neither holds with a Map.

## Decision

- **One database, SQLite, through `node:sqlite`** (built into Node 24, so no dependency is added). The file is
  `DATABASE_PATH`. The building blocks own `src/Architecture/Infrastructure/Sqlite/`: `SqliteDatabase` (the file, its
  connections and the transaction turn), `SqliteUnitOfWork` (the four methods of the unit of work, over it) and
  `SqliteOutbox` (the outbox, a table written in the transaction that made the fact, ADR 24).
- **Two connections per process.** The writer holds every transaction: `BEGIN IMMEDIATE`, so one transaction at a time
  writes, across every server on the file (SQLite's lock, with a busy timeout). The reader answers the reads outside a
  transaction, from the committed data, in WAL mode, and is never blocked by a writer.
- **One transaction at a time per process** (the turn). A write outside a transaction (`writeAlone()`, used by the
  outbox to mark an entry published) takes the same turn, so it never lands inside another request's transaction.
- **Values the servers must agree on are kept in the file** (`settings`, `setting()`): the key that signs tokens is made by
  the first server that starts and read by every other one, so a token issued by one server is accepted by all of them,
  and after a restart.
- **No migration framework.** The schema is `CREATE TABLE IF NOT EXISTS` at open, a context's own tables beside the
  building blocks'. A change to a table that is already in use is a new decision.

## Consequences

- A use case reads committed data. Its reads come from the reader, so a read after its own write inside the same
  transaction does not see that write. A use case reads before it writes; a context that needs otherwise asks its
  adapter for the writer and says so.
- One write runs at a time in a process, and across servers the second waits for the lock. That is the throughput of
  this design; it is ample for a shared-expenses app and is the first thing to measure when it is not.
- Delivery stays at least once: an entry is deleted only after its reactions have run (ADR 24), so a crash between the
  two publishes it again.
- The in-memory unit of work stays the default of `FastifyApplication`, so a test that needs no file needs none.

## When to revisit

When a second process type needs the database over a network, or when write throughput is measured as the limit: then
a server database replaces the file, and the four methods of the unit of work are what it has to provide.
