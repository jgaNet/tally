# 29. The application keeps its state in PostgreSQL, and moves what its SQLite file held into it once

## Context

Feature 30: Tally is outgrowing a database file. Its state is one SQLite file, named by `DATABASE_PATH`, opened through `node:sqlite`, and
written under `BEGIN IMMEDIATE` so that two servers on one file serialise their writes (docs/adr/0002). From now on it keeps everything in the
PostgreSQL database named by `DATABASE_URL`. A server started on an empty database while `DATABASE_PATH` names a file Tally kept moves what the
file holds into the database, then serves; a server started on an empty database with no such file prepares it and serves at once. Nothing a
client sees changes: every request answers as it did, with two servers on one database and a server killed at any moment and started again.

The storm (`conventions/storms/postgresql.yaml`) was decided with the product's owner before any code. Its three hot spots are decided and this
record keeps them.

## Decision

- **One database, the tables of each context as they were.** Every table of the SQLite file is a table of the PostgreSQL database with the same
  name and columns; each context's outbox (ADR 24) and the bus's inbox are tables of it too. The adapters change from the synchronous `node:sqlite`
  calls to asynchronous `pg` calls; the domain and the application layers do not. The ports were already asynchronous. Where a store read the
  file's order by `rowid`, the table has an explicit `seq` column that numbers its rows as they were inserted, so every list keeps its order.
  Foreign keys are `DEFERRABLE INITIALLY DEFERRED`, so a move may insert rows in any order inside one transaction.
- **A unit of work is one transaction on one connection** (`PostgresUnitOfWork`, `PostgresDatabase`). Within a process one transaction at a time
  holds the process's turn, as the SQLite file's did; across processes every transaction takes a transaction-scoped advisory lock when it begins,
  so a second writer waits for the first, as `BEGIN IMMEDIATE` made it wait. The optimistic version checks of the aggregates are unchanged
  (ADR CONC-OPTIMISTIC): they hold under the lock as they held under the file's.
- **The move lives in the Bootstrap, before the server serves** (`src/Bootstrap/Database/prepareDatabase.ts`, `moveSqliteFile.ts`). Under the
  advisory lock, in one transaction: if the database holds no table of Tally's, every schema step runs, then, when `DATABASE_PATH` names an
  existing file, the file is upgraded by the steps its version of each adapter ran on opening (`src/Bootstrap/Database/legacy/`) and every row is
  copied, table by table, in the order the file kept it; then the seed steps run (the session key, which is kept once and reused). A second server
  waits for the lock, finds the tables, and does nothing. From then on the file is not read again. No context's domain knows of the move.
- **The outbox and the bus's record move with the state.** The outbox's entries move in their order, so an entry the file stored and did not relay
  is relayed after the move, and an entry the file already published is gone and is not relayed again. The bus kept its record of what each
  subscriber handled in memory; that record is now the `inbox` table, keyed by the subscriber (its channel and its place in the wiring) and the
  message's id, so a message a subscriber handled before a restart is not handed to it again. The file never held that record, so nothing of it
  moves; it is durable from this version on.
- **A payment in flight is counted once.** The settlement book moves as it is: its pending settlement, its payment id, its status history. The
  webhook that arrives after the move moves the settlement forward once, as request 14 does (docs/adr/0014, 0015).

## Consequences

- The Architecture gains `src/Architecture/Infrastructure/Postgres/` (the database, the unit of work, the inbox), and its outbox adapter is
  `Infrastructure/Outbox/PostgresOutbox.ts`; the bus takes an `Inbox` port, with an in-memory default for the tests of the bus. The `pg` driver is a dependency.
- The tests run each end-to-end suite on a database of its own (`useFreshDatabase`), created on the server `DATABASE_URL` names. The suites no
  longer write a file in the temporary directory.
- Schema steps only create (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); rows a database needs at its start are seed steps. A
  context adds a table by its schema step, and its legacy file, if the table was ever a file's, by its upgrade.
- A file the database cannot take is refused, not dropped: a table of the file that Tally does not keep fails the move, and the transaction rolls
  back, leaving the database empty and the file in place for the next start.
- The database's pool is closed when the application stops, and a suite's pool is closed when its application is.
