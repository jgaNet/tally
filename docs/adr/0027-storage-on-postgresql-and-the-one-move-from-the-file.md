# 27. Storage on PostgreSQL: one database, the tables of each context as they were, the outbox and the bus's record in it, and one move from the file

## Context

Tally kept its state in one SQLite file (`DATABASE_PATH`), opened by each context's adapters with the synchronous `node:sqlite` driver and written
inside `SqliteFile` transactions: a process-wide gate for writers in the process, and `BEGIN IMMEDIATE` for writers in other processes on the same file (ADR 17).
Tally is outgrowing a file. Feature 30 (`conventions/storms/postgresql.yaml`, decided before the code) moves its state to PostgreSQL: a server started on an empty
database prepares it and serves; a server started on a database that holds nothing of Tally's yet, while `DATABASE_PATH` names a file Tally kept, first moves
everything the file holds into it, then serves, and the file is not read again. Every request behaves as before, with two servers on one database, and a server
killed at any moment and started again. The API does not change.

The storm's hot spots are decided and held: one database for the contexts, with the tables of each as they were (the outbox and the bus's record included), the
adapters changed and the domain and the application layers not; the move lives in the Bootstrap, as a step before the server serves, under one lock; and a
payment in flight stays counted once, as request 14 keeps it.

Two things in the code were not durable before this feature: the outbox (ADR 24) was an in-memory store, and the bus's inbox (what each subscriber has handled) too,
so a fact committed with its state but not yet published was lost with the process.

## Decision

- **No new context and no new relationship.** The contexts are the same, and so are their links. What changes is the storage they are adapters over: Groups,
  Ledger, Settlements and Notifications keep their tables in the one database at `DATABASE_URL`, each under its own tables, as they did in the file. The Bootstrap
  adds two tables of its own, the outbox and the bus's inbox, and one of its state (`storage_state`).
- **A transaction is a PostgreSQL transaction, and writers take turns.** `PostgresDatabase` (Architecture, Infrastructure) gives each transaction a pooled
  connection, begins it, and takes one advisory lock for the database before any write: writers across all servers take turns, as `BEGIN IMMEDIATE` made
  them. Reads take no lock and see what is committed. A transaction begun inside another one in the same async chain joins it (a repository's write is the
  transaction of the use case that decided it), and a transaction whose work throws rolls back what it wrote.
- **The unit of work is the transaction of the request.** `PostgresUnitOfWork` begins a transaction and enters its scope in the chain that begins it, so every
  query the request makes after that, the repositories' and the outbox's, runs in it; commit and rollback end it. A reaction runs in a unit of work of its
  own (`another()`), as before.
- **The outbox is a table, appended in the transaction of the state it describes.** `PostgresOutbox` writes a fact as a row (`outbox`) at commit, inside the
  transaction, so a rollback drops it with the writes it describes; a published fact's row is deleted; the relay at start publishes what a killed server left.
  Delivery stays at least once (ADR 24).
- **The bus's record is a table.** `InMemoryEventBus` takes an `Inbox` (its default keeps it in memory, for the building blocks' specs); the bootstrap gives it
  `PostgresInbox` (`bus_inbox`), keyed by the subscriber (channel and handler class, and the occurrence among them, stable across restarts) and the message's id.
- **The move is a step of the Bootstrap, under one lock.** `prepareStorage` makes every context's tables and the Bootstrap's own, then, when `DATABASE_PATH`
  names an existing file and the database holds no row of Tally's (the signing key the set-up makes aside) and no `moved_from_file` marker, `moveFromFile`
  copies every table the file has, in one transaction under the writers' lock: each table with the columns both have, the rows in the order the file kept them,
  the identities kept (a pass's id names its `seq`). A column the file predates takes the database's default; an expense the file predates the order of takes
  its rowid; a balances table the file predates is made from the expenses it holds; a settlement without a history line gets the line it was recorded with
  (`backfill`). The marker is written in the same transaction, and a server that starts after it does not read the file again. The signing key of the access
  tokens is replaced by the file's, so the tokens already issued still verify.
- **Each context's tables are one `PostgresTables`.** A context's set-up is idempotent DDL, run once per process under the writers' lock; its backfill is DML that
  runs after a move. The contexts' repositories read and write through their tables, with the statements of the SQLite adapters moved as they were: a row's
  `rowid` order is a `seq` column, and a unique-key conflict is `ON CONFLICT DO NOTHING` checked by its row count, not by an error.
- **Tests run on databases of their own.** `freshDatabaseUrl()` (the spec helper) creates a database on the server `DATABASE_URL` names for each spec file, or each
  test of an adapter spec, so no test shares state with another; the pools are closed when the application stops.

## Consequences

- `DATABASE_URL` is required; `DATABASE_PATH` names a file only to be moved from, once. `NOTIFICATIONS_DATABASE_PATH`, `LEDGER_DATABASE_PATH` and
  `SETTLEMENTS_DATABASE_PATH` are gone: every context is in the one database.
- The adapters' file names (`Sqlite…`) are kept, so that the history of the features that wrote them stays readable; what they are over is PostgreSQL.
- The ADRs that describe the SQLite file (ADR 5, 11, 17) describe the features as they were built; this one says what they are over now.
- A file moved in is read once. A file that is moved from and left on disk is not read again by a server started on the database it went into.
- Honest limit: the move copies a file of any layout Tally has kept, but the SQLite adapters' own upgrades (`migrate`, `#migrate`) are no longer run: a file is
  brought to the layout of the database by the copy, which fills what the file predates with the database's defaults and the backfills above.
