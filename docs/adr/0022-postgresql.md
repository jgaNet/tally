# 22. PostgreSQL is the one store, and a first start moves the SQLite file into it

## Context

Feature 30 (storm `conventions/storms/postgresql.yaml`): Tally keeps all its state in the PostgreSQL database
`DATABASE_URL` names, instead of the SQLite file of ADR 2. A server started on a database that holds nothing of Tally's
yet, while `DATABASE_PATH` names a file Tally kept (by this version or an earlier one), moves everything the file holds
into it before it serves; nothing is lost, and a payment waiting at the provider lands once when its webhook comes. A
server on an empty database with no file prepares it and serves. Every request behaves as before, with two servers on
one database and a server killed at any moment. No command, query, fact or relationship changes: this is the storage of
every context, so it is decided here, in the building blocks and the composition root.

## Decision

- **One database, the tables as they were.** Every context keeps its tables, with their names and columns, in one
  PostgreSQL database (one schema): Groups', Ledger's, Settlements', Notifications', the Tracker's operations, and the
  one outbox the unit of work appends to. Only the adapters change (`Sqlite*` → `Postgres*`, the SQL in PostgreSQL's
  dialect: quoted camelCase aliases, `ON CONFLICT`, `BIGINT`, `BIGSERIAL`); the domain and application layers do not. A
  table whose queries read rows in the order they were written (SQLite's `rowid`) has a `rowid BIGSERIAL` column, so the
  queries are unchanged and the move keeps the order.
- **The building blocks** replace `src/Architecture/Infrastructure/Sqlite/` with `Postgres/`: `PostgresDatabase`,
  `PostgresUnitOfWork`, `PostgresOutbox`, over the `pg` driver (a dependency now; `node:sqlite` stays only for reading
  the file). The rules of ADR 2 hold as they were: one connection per process, taken in turns — a repository inside a
  command uses `connection`, the turn its transaction holds; anything outside a transaction uses `exclusive()`.
- **Two servers, one order.** Every write transaction takes one advisory lock (`pg_advisory_xact_lock`) after `BEGIN`:
  the second server's transaction waits for the first's commit and then reads what it left, exactly as `BEGIN IMMEDIATE`
  on the file did. Every decision that was safe on the file (an email's uniqueness, a recurring day recorded once, a
  settlement never more than is owed, the optimistic versions) is safe for the same reason, with no isolation level to
  reason about. A server killed in a transaction leaves nothing: PostgreSQL rolls back a connection that is gone.
- **Migrations** stay `CREATE … IF NOT EXISTS` and backfills (`INSERT … ON CONFLICT DO NOTHING`) given by each adapter at
  construction; they run in order before the first turn, in a transaction under a second advisory lock (the schema lock),
  so two servers starting at once prepare the tables once.
- **The move lives in the Bootstrap** (`src/Bootstrap/Fastify/moveFromSqliteFile.ts`), a step of `createApplication`
  after every adapter is built and before anything is relayed or served; no context knows it. Under the schema lock, in
  one transaction: if the database has no `tally_storage` row, the file `DATABASE_PATH` names (when it exists) is read
  table by table and copied into the table of the same name, the columns both have; the serial sequences are advanced
  past what was copied; every migration runs again over it, so a file of an earlier version gets the backfills this
  version's start gives (an expense's split kind and category, the balance entries, a settlement's history); then the
  `tally_storage` row is written. A second server waits on the lock and finds the row; a server killed during the move
  leaves nothing, and the next start moves it all. The file is never read again (nor written).
- **What was in flight moves with it.** The outbox's entries are the facts stored and not relayed yet (a relayed one is
  deleted): they move, and the startup relay publishes them after the move, once; nothing relayed before is relayed
  again. The token secret moves (`settings`), so a token given before the move still signs in: `HmacTokens` reads it
  in `load()`, after the move. A settlement through the provider moves as it was — pending, with its payment id and its
  history — and the webhook that comes after moves it forward once, as request 14 does.
- **The bus's inbox** (which subscriber handled which message) stays in the process, as ADR 24 of the reference has it:
  the file held none, so there is nothing to move. A fact delivered again after a restart finds its effect already made,
  as before.
- **Tests** run against the PostgreSQL server `DATABASE_URL` names: `jest.setup.js` gives each test file a database of its
  own (`tally_test_<uuid>`), which `PostgresDatabase` creates on its first use. The move is tested end to end against a
  file the previous version wrote (`tally-before-postgresql.sqlite`), with a second server started on the same
  database and killed.

## Consequences

- A process serves one transaction at a time, and servers write one at a time, as on the file: throughput is what it was,
  not what PostgreSQL could give. Reads outside transactions do not take the write lock.
- `DATABASE_URL` is required; `DATABASE_PATH` only says where a file to move is. A file named but missing is no file.
- Test databases are left on the test server.

## When to revisit

When one writer at a time is too slow: per-aggregate row locks (`SELECT … FOR UPDATE`) and a pool of connections, with
each cross-aggregate rule (an email, a recurring day, what is owed) given a constraint or a lock of its own.
