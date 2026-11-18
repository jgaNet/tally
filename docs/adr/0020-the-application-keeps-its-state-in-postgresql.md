# 20. The application keeps its state in PostgreSQL, and moves a SQLite file into it once (no new context, no new relationship)

## Context

ADR 2 kept the application's state in one SQLite file, one connection per process, and a turn at the file that serialised
every read and write. Tally is outgrowing a file: its state must live in PostgreSQL, and what the file held must move with it,
without a request seeing a difference. The storm `postgresql`, decided with the product's owner (`conventions/storms/postgresql.yaml`),
settled three hot spots: one database for the contexts, with the tables of each context as they were; the move from the file
in the Bootstrap, once, before the server serves; and the payment in flight, which must still be counted once after the move.

No context and no relationship is added: the contexts and the map are unchanged, so this is an architecture task of the
infrastructure only. Domain and application code do not change; the adapters do.

## Decision

- **One database, `DATABASE_URL`.** Every context's tables are the ones they were, in one PostgreSQL database, with the transactional
  outbox (ADR 24) and the operation records beside them. Each adapter declares its tables with `define()` when it is constructed,
  and the database makes them when it is opened (`PostgresDatabase.open()`), in one transaction under an advisory lock. No
  constructor runs a query.
- **Transactions.** A unit of work (`PostgresUnitOfWork`) takes a connection of its own for its transaction, and its scope
  (`AsyncLocalStorage`, as ADR 4 has it) carries that connection to every query the transaction makes: a transaction's reads see its
  own writes, and no one else's. Reads outside a transaction run on the pool and see what is committed, so they need no turn; the
  per-process turn is kept for writes only, and the writes are serialised across the servers that share the database by a
  transaction-scoped advisory lock taken at the begin, as `BEGIN IMMEDIATE` did for the file (ADR 2). ADR 2's guarantee holds: a query
  never sees a transaction in progress.
- **Adapters** are the SQLite ones, converted: the same tables, columns and formats; `INSERT OR REPLACE` is an upsert, the
  `AUTOINCREMENT` columns are `BIGSERIAL`, and the upgrade code for files kept by earlier versions is gone from the adapters.
- **The move.** The Bootstrap opens the database with `importSqliteFile` as the step before it serves (`createApplication`).
  The step runs in the setup transaction, after the schema is made: if the database holds nothing of Tally's yet (its `settings`
  table does not exist) and `DATABASE_PATH` names a SQLite file that exists, every table of the file that the schema makes is copied,
  row for row, in the order it was kept, and the copy and the schema commit together. A second server waits on the setup lock and
  finds the database holding Tally's tables; the file is not read again. A file kept before some columns existed is completed as
  the SQLite code completed it (`recorded_seq` from the rowid, the balance entries of the expenses). The copy includes the
  `settings` table (the signing secret, so the tokens issued before the move are still accepted), the outbox with its order,
  and the operation records (the bus's durable record of what it delivered). The fact an outbox entry waits for is relayed
  after the move, as before; a payment in flight keeps its settlement, payment id and history in the settlement book, so the
  webhook that comes after the move counts it once (request 14).
- **A fresh database** with no file is prepared and served at once.
- **Secrets.** `secret(name)` is async. A component that needs a secret takes a provider and asks for it when it first
  needs it, after the database is open: the signing key is never read at load time.
- **Tests.** Each test file gets a database of its own, made on the server `DATABASE_URL` names (jest.setup.js), and no
  test has a file to move.

## Consequences

- The application needs a PostgreSQL 16 server reachable at `DATABASE_URL`; the process fails with a clear message when it is unset.
- Writes are serialised as before, so the optimistic version checks (CONC-OPTIMISTIC) are not the only guard; they remain
  the rule. A long transaction still holds the others up, so transactions hold no slow step.
- The bus's inbox is process-local and is not stored; the durable record is the outbox and the operation records, which move.
  A fact the bus delivered before the move and whose outbox entry was already removed is not relayed again; a subscriber still
  tolerates a repeat (at-least-once, ADR 24).
- A SQLite file is read by Node's built-in `node:sqlite` only for the move, once.

## When to revisit

- When the relay runs on several servers often enough that duplicate publication costs something: the relay claims its entries
  (a row lock or a lease).
- When a single transaction takes long enough to hold the writes back: a read model may then be written outside the command's transaction.
- When `node:sqlite` leaves Node: the move reads the file with a different reader, and the rest is unchanged.
