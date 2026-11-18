# 25. The state is in PostgreSQL, and the SQLite file is moved into it once

## Context

Feature 30 of Tally (storage on PostgreSQL) was stormed before the code (`conventions/storms/postgresql.yaml`, decided with the
product's owner). Until now the application kept everything in one SQLite file that every server shared (ADR 2): the outbox (ADR 24),
the inbox (ADR 12), the settings, and each context's tables. From now on it keeps it in the PostgreSQL database at `DATABASE_URL`.
Nothing a client sees changes: no command, query or fact is added, and no context or relationship is.

The database is the building blocks' (`src/Architecture/Infrastructure`), so this is an architecture task (`architecture mode
architecture`): the adapters change; the domain and the application layers do not.

## Decision

- **One database, the tables of each context as they were.** `PostgresDatabase` replaces `SqliteDatabase` (and `PostgresUnitOfWork`,
  `PostgresOutbox`, `PostgresInbox` the others), and each context's `Sqlite…Store` becomes `Postgres…Store` over the same tables, each
  context's outbox and inbox included. Its schema statements are still written once, by the store, and `CREATE TABLE IF NOT EXISTS`
  prepares them at start. Integers are 64-bit and are read as numbers; text is compared by its bytes (`COLLATE "C"`), as the file did, so
  every ordering the API shows is the one it showed; a table that was listed by the order its rows were written has a `rowid` identity
  column in the place of SQLite's.
- **One writer at a time, as before.** A transaction takes the process's turn, opens, and takes an advisory lock the database holds for
  every server: so two servers on one database write one transaction at a time, the optimistic checks (ADR 8) hold, and a use case reads
  what is committed. Reads that are not part of a transaction go to a pool and see what is committed. The reaction's transaction
  (ADR 12, ADR 30) and the relay after the commit (ADR 24) are unchanged: their ports are the same, now over the database.
- **The move from the file lives in the Bootstrap**, as a step before the server serves (`Bootstrap/Fastify/MoveSqliteFile.ts`, given to
  `PostgresDatabase.open()`). The preparation of the database is one transaction under one advisory lock: it looks whether the database
  holds anything of Tally's (its `settings` table), makes the tables, and, on a database that holds nothing and when `DATABASE_PATH`
  names a file, copies into it every table the file has, row by row in the order the file kept them, the parents of a foreign key first,
  the columns both have; then it runs the schema's statements again, which fill from what is there what an earlier version's file did not
  have. A second server started at the same time waits for the lock and finds it done; a server killed in the middle leaves nothing,
  and the next one does it all. The move knows no context, and no context's domain knows it. Once the database holds the application's
  tables the file is not read again.
- **What was in flight goes with it.** The outbox's entries and the inbox's marks are tables like the others: a fact relayed before the
  move is not relayed again, and one stored but not relayed is relayed at the start. The settings go too, so the tokens signed before are
  still proofs. The settlements' book goes as it was, a payment waiting at the provider with its payment id and its history, so the
  webhook that comes after the move finds it by its payment id and moves it forward once, as request 14 does.

## Consequences

- `DATABASE_URL` is required; `DATABASE_PATH` is read only to be moved. The tests start each suite on a database of its own on the
  server `DATABASE_URL` names (`freshDatabase()`), and the move is held by a real file an earlier version kept
  (`Bootstrap/Fastify/fixtures/`).
- An adapter's statements are asynchronous all through: a store awaits what it reads and writes. A failed statement aborts the
  transaction in PostgreSQL, so an adapter that catches a conflict (a unique key) throws the concurrency conflict and the transaction is
  rolled back, which is what each did.
- ADR 2's choice of SQLite is superseded where it names the file; its rule that every server shares one store and one write at a time
  holds.

## Revisit when

A second database is needed for a context (the tables are one database's today), or the write lock becomes the limit of throughput:
the optimistic version checks would then be the only guard, and the lock a per-group one.
