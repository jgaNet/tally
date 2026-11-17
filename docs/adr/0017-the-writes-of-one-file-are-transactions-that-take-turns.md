# 17. The writes of one database file are transactions that take turns, on one connection per process

## Context

The contexts keep their rows in SQLite files: by default one file, `DATABASE_PATH`, and each context may name its own (ADR 5, ADR 9).
Until request 20, each write was one statement or one `BEGIN IMMEDIATE` … `COMMIT` inside a single synchronous call, and each decision
read its inputs in a separate step. A decision that reads state, then writes it, was therefore only as safe as its own version check.

Request 20 needs more than that. A member's leave reads their balance (Ledger), reads whether a payment waits (Settlements), and removes
them from the group (Groups). An expense that includes them reads the membership and writes its shares. Either order must hold: the
expense is counted in what passes, or it is refused because its member is gone, and the balances add up to 0 either way (the storm's
hot spot: "serialised on the one database"). No version check on the group sees an expense, because an expense is not a change to the
group, so the two decisions must be made inside one transaction on the one file.

Node's SQLite binding is synchronous, and the decisions await ports between their reads and their writes. A transaction that spans those
awaits must therefore be the only writer of its file while it lasts, in this process and in any other server on the same file.

## Decision

- **One connection per file, per process.** `SqliteFile` (in the building blocks' Infrastructure) opens a file once, under its resolved
  path, with WAL and a busy timeout; every context that names the file gets the same object, so one connection serves them all.
- **One turn per file.** `SqliteFile.transaction(work)` waits for the file's turn in this process (a promise queue), then runs `work` in
  `BEGIN IMMEDIATE` … `COMMIT`. A throw rolls back everything `work` wrote. Other servers on the same file wait in `BEGIN IMMEDIATE`
  (the busy timeout), so the transaction is the file's only writer while it lasts.
- **A transaction joins the one it is inside.** The turn is re-entrant in the async chain that opened it: a repository's write inside a
  use case's transaction is the same transaction, so the use case's read and write are one state (`inTransaction` on the repositories
  that a decision reads and writes: the groups, the expenses, the settlement books).
- **Every write takes a turn.** The writes of the groups, accounts, invitations, expenses, settlements, payout accounts, notices and debt
  watches are transactions of their file. The schemas are set up once per file, idempotently, in a transaction (`SqliteFile.schema`).
- **The commands that decide on balances or membership** run in one transaction: the leave, recording, editing and deleting an
  expense, and the settlements (cash, through the provider, refunds). A payment's link is asked of the provider inside its transaction,
  so the payment is decided on the balances it was asked for.

## Consequences

- An expense or a settlement recorded at the moment a member leaves is either before the leave (its share is in what passes) or after it
  (refused: its member is gone), in one process or two on the same file (the tests run both a race in one process; the other process
  waits in `BEGIN IMMEDIATE`).
- The whole file is serialised: a writer waits for another writer, and a payment's provider call holds the file for its duration. The
  provider's timeout bounds that wait.
- Reads take no turn. They read committed rows, but a read made while a transaction is open on the one connection sees that
  transaction's writes, and loses them if it rolls back: an honest limit of one connection per process, which the storm's hot spots do not
  need closed. A read that must not see a write in flight would need its own connection.
- The guarantee is per file. The contexts must name the same file (the default) for a leave and an expense to take the same turn; a
  deployment that splits them (`LEDGER_DATABASE_PATH`, `SETTLEMENTS_DATABASE_PATH`) gives no such guarantee, and says so here.
- The access tokens' signing key is written once, when the groups' file is set up, so that signing only reads it.

## When to revisit

When a deployment splits the contexts over several files and needs the leave and an expense to stay exact, or when a read must never
see a write in flight: then a reader connection per request, or a database that isolates transactions by itself, replaces the shared
connection.
