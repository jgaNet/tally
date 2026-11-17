# 2. One SQLite file, and accounts that sign in

## Context

Request 1 (accounts) asks that what the application knows survives a server stopped abruptly, and that several servers
may run on the same file at once. Until now every store was in memory: the unit of work, the outbox and the Tracker's
operation records. Accounts also need a way to prove who is calling.

## Decision

- **SQLite is the one store**, the file `DATABASE_PATH` names (`tally.sqlite` when it is unset, in memory under test),
  opened with Node's built-in `node:sqlite`: no dependency. The building blocks gain `SqliteDatabase`,
  `SqliteUnitOfWork` and `SqliteOutbox` under `src/Architecture/Infrastructure/Sqlite/`; the in-memory adapters stay for
  specs.
- **One connection per process, turns in order.** The connection is synchronous, so an open transaction would take in
  whatever else is written meanwhile. A transaction waits for its turn (`acquire()`), and whatever is not in a
  transaction (queries, the Tracker's records, the outbox bookkeeping) goes through `exclusive()`, which waits for the
  transaction in progress. Between processes the file's lock decides: `BEGIN IMMEDIATE`, WAL, a 30 s `busy_timeout`;
  the second writer reads what the first committed, so the uniqueness of an email is decided on committed state (and a
  `UNIQUE` index backs it).
- **The outbox is in the file**, appended in the command's transaction and relayed after the commit, and again at start:
  a fact a crash kept from being published is published by the next server (EVENT-AFTER-COMMIT). Delivery is at least
  once; two servers relaying the same entry at the same moment may deliver it twice, which the contract already allows
  of a subscriber.
- **The Tracker's operations are in the file**, so a restarted server, or another one, answers an operation a client was
  given. They are served at `GET /v1/operations/{operationId}` as request 1's fragment says; the administrators' list is
  not part of the API and has no route.
- **Accounts live in Groups** (T1, ADR 1). `Account` is an aggregate (email, name, password hash); sign-up is the command
  `SignUp` (anyone may ask, answered `202` and read as an operation whose result is the id); signing in is the query
  `Login`, since it changes and records nothing.
- **Passwords** are checked for their length by the domain (`Password`), then hashed by a port (`IPasswordHasher`, scrypt
  with a salt of its own): the salt is non-determinism the domain does not own. A wrong password and an unknown email
  are one refusal, after the same work.
- **Tokens** are `<account id>.<HMAC-SHA256 signature>`, signed with a secret generated once and kept in the file, so every
  server on the file issues and verifies the same tokens and a restart still honours them. A token carries no time and
  does not expire: nothing changes by someone reading it.
- **The email** is kept in lower case, which makes its uniqueness case-insensitive; it must be something, `@`, something
  with a dot, so the shared kernel's `Email` no longer asks for two letters after the last dot.
- **A body's shape is the transport's**: Fastify no longer coerces types (`coerceTypes: false`), so a number where a string
  is asked is a `400`; whether a value is allowed is the domain's, and its refusal is the operation's `ERROR`.

## Consequences

- Every later store, repository and query is written over `SqliteDatabase`: a repository inside a command uses its
  `connection`, a query uses `exclusive()`.
- The composition root builds one database per process (`SqliteDatabase.shared()`).
- An operation accepted and not finished when a server dies stays `PENDING`: the command is not replayed.

## When to revisit

If a request needs a token that can be revoked or that expires (it would have to be a change a job makes, not a read),
or when two servers delivering the same outbox entry twice starts to matter to a subscriber.
