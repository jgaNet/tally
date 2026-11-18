# 21. The application keeps its state in PostgreSQL, and moves what its SQLite file held into it once

## Context

ADR 2 kept everything in one SQLite file, `DATABASE_PATH`, opened by Node's built-in `node:sqlite`. Feature 30 moves the state to the
PostgreSQL database `DATABASE_URL` names. Nothing a client sees changes: no command, query, fact or route is new, so no context and no
relationship is declared; this is a change of the adapters of the ports the contexts already own, which the architecture mode records here.
The storm (`conventions/storms/postgresql.yaml`) decided three hot spots, which this ADR carries out.

## Decision

- **One database, the tables of each context as they were.** Each context keeps its tables (`accounts`, `groups`, `expenses`, `settlements`,
  `notices`, `operation_records`…), and the building blocks' `outbox`, in the one database. The domain and the application layers do not
  change; the adapters do: `Sqlite*` became `Postgres*`, over `PostgresDatabase`, `PostgresUnitOfWork` and `PostgresOutbox`
  (`@Architecture/Infrastructure/Postgres`). The driver is `pg`. The inbox of the bus is the bus's own, in memory (ADR 24 of the reference),
  and was never in the file; there is nothing of it to move.
- **The same shape, asynchronous.** `PostgresDatabase` keeps `run`, `get`, `all`, `lock()` and `exclusive()` as `SqliteDatabase` had them, now
  returning promises, over one connection per process. A transaction is `BEGIN` followed by one advisory lock of the database's writers
  (`pg_advisory_xact_lock`), the counterpart of `BEGIN IMMEDIATE`: two servers on one database queue as they queued on a file, a reader never
  waits for a writer, and a server killed at any moment releases the lock with its connection and rolls its transaction back.
- **Order is a column.** What `rowid` ordered is now `seq BIGSERIAL`; text is compared byte for byte (`COLLATE "C"`), as the file compared it, so
  that no listing changes its order; integers are `BIGINT`, read back as numbers. A table is declared by whoever needs it (`declare`) and made once.
- **Where the move from the file lives: the Bootstrap, before the server serves.** `createApplication` calls `database.prepare(moveFromFile(DATABASE_PATH))`.
  `prepare` runs in one transaction, under the writers' advisory lock: it makes the tables, and only if the database held nothing of the application's
  (it has no `tally_meta` table), runs the move, then marks the database prepared. A second server started at the same time waits for the lock and finds
  it done; a server killed halfway leaves nothing, because DDL is transactional. A database that is prepared never reads the file again; a fresh database
  with no file is prepared and serves at once. No context's domain knows it.
- **What moves.** Every table of the file, row by row in the order it was stored, into the table of the same name, by the column names both have: the state, the
  signing secret (so tokens stay good), the outbox (a fact stored and not relayed is relayed once the server serves; a fact already relayed is not in the outbox,
  so it is not relayed again), the operations, and the settlements' books, so that a payment waiting at the provider keeps its pending settlement, its payment id and
  its history, and the webhook that comes after the move moves it forward once, as request 14 does. A file made by an earlier version lacks columns a later one
  added: the database's defaults are what the earlier version meant, and the derived values the earlier code made in place (an expense's recording order, a member's
  join time, a settlement's first history line) are made by the move.
- **Suites** keep their tables in a schema of their own (`DATABASE_SCHEMA`, set by `jest.setup.js`), so that suites run side by side on the one database.

## Consequences

- `DATABASE_URL` is required; `DATABASE_PATH` is read only to be moved, once. `node:sqlite` is used by the move alone.
- ADR 2 is superseded as to the store; its reasoning about one transaction at a time in a process and about the outbox stands.
