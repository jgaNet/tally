# 2. Accounts: SQLite, the Account aggregate, and signed tokens

## Context

Feature 1 (`conventions/storms/accounts.yaml`, the product's `1-accounts`) signs people up and in and lets a
signed-in person read their own account. Three things it needs are not in the application yet, and each one is
a decision rather than a detail:

1. **Persistence.** The application keeps everything in memory: the unit of work snapshots in-memory stores,
   the outbox is a Map. The product needs what it knows in one SQLite file (`DATABASE_PATH`), kept across restarts,
   and shared by several servers running on that file at once.
2. **An aggregate and a domain event in a Lite context.** The storm decided that the sign-up command writes an
   `Account` aggregate and records an `AccountRegistered` event. Under the Lite profile (ADR 40) both come in by an
   ADR, never quietly (`yarn architecture profiles`). This is that ADR.
3. **A transport that refuses what the API names.** The product's API names `400` for a body whose shape is wrong
   and `401`, `403`, `404`, `409` or `422` for every other refusal. The transport answered `400` for any rule, and
   Fastify's default validator coerced types (a number sent for a string was accepted).

Accounts stay in Groups (ADR 1, T1): no context and no relationship is added here, so the context map is unchanged.

## Decision

- **Persistence is one SQLite file, opened on first use** (`src/Architecture/Infrastructure/Sqlite`), through
  `node:sqlite`, which Node 24 ships, so no dependency is added. The path is `DATABASE_PATH`, `tally.db` when unset.
  - A **unit of work** is a transaction on that file: `BEGIN IMMEDIATE` at begin, `COMMIT` or `ROLLBACK` at the end.
    Within one process, one transaction at a time holds the file's turn (`SqliteDatabase.acquire()`), so a request
    never reads another request's uncommitted writes. Across processes, `BEGIN IMMEDIATE` and `busy_timeout` make a
    second writer wait. The file runs in WAL mode.
  - **Stores run inside a transaction only** (`assertInTransaction()`). A read that is not a transaction (a query)
    takes the file's turn for its one statement (`exclusive()`).
  - **The outbox is a table** (`outbox`) written in the transaction of the state it describes, read and deleted by
    the relay after the commit (ADR 24). A rollback removes its entries with the writes.
  - The in-memory unit of work and outbox stay: the unit specs of the building blocks use them, and a context's
    unit specs may use an in-memory store.
- **The `Account` is an aggregate root and `AccountRegistered` a domain event, of Groups** (the storm's decision,
  brought in here as Lite requires). `Account.create()` validates nothing it is not given, generates the id
  (`Id.generate()`) and records `AccountRegisteredEvent`. `fromSnapshot()` records nothing and throws on corrupted
  data. The event is recorded and stored with the account; no context reacts to it yet, so it is published to the
  outbox and to nobody. A reaction brought by a later feature is a decision of that feature.
  This is the first aggregate of Groups, and it is brought in for the storm's sake, not for a second writer: the
  Lite trigger (several writers) has not fired. The next storm that adds a second command on an account decides
  whether the aggregate stays.
- **The store saves the version + 1 and refuses a stale version** with `ConcurrencyConflictException` (ADR 8), as
  the aggregate's contract says. The email is unique in the table, whatever its case (the shared kernel's `Email`
  lowercases it), so two servers signing up one email store one account: the other is refused with
  `EmailAlreadyUsed`.
- **Tokens are signed, not recorded.** A token is `<account id in base64url>.<HMAC-SHA256>`, keyed by a random key
  kept in the database's `secrets` table, created on first open. Every server on the file holds the same key, and a
  token outlives a restart. Signing in records nothing (the storm). A token has no expiry: the product names none,
  and a later feature that needs one changes the token, not the store.
- **Passwords are hashed with scrypt** and a random salt, behind a port (`IPasswordHasher`) because the salt is
  randomness (DOMAIN-NON-DETERMINISM).
- **Refusals by kind.** `AnswerAtOnce` answers a value the domain refuses with `422`, a thing that already exists
  (`AlreadyExistsException`, such as an email in use) or a concurrency conflict with `409`, and a missing or
  unaccepted caller with `401`. The body schema says the shape only: a string is a string, and a number sent for it
  is refused with `400` (Fastify's validator no longer coerces types).
- **The API's operation route exists**: `GET /v1/operations/{operationId}` answers `404`, since a Lite application
  never answers a command later and so never makes an operation (the fragment `api/2-accounts.yaml`).
- **Background job.** The composition root relays the outbox at start and then every `JOBS_INTERVAL_SECONDS` (60 when
  unset). Nothing in this feature changes with time; the job is there so that a fact a crash kept from being
  published goes out without a later commit.

## Consequences

- A relay on one server can hand an entry that another server also hands: the bus delivers once per process, so
  a subscriber on several servers may see a fact twice (at-least-once, as ADR 24 already says). No subscriber of
  the accounts' events exists yet.
- The token key is in the database file: whoever can read the file can sign tokens. The file is as private as the
  data in it.
- Every store operation of a use case runs in its transaction; a use case that reads outside one fails with a clear
  message, which is the point.
- The in-memory adapters that the feature's specs use (`InMemoryAccountRepository`) are not the production store.

## When to revisit

- When a second command writes an account (a name change, a password change): the Lite trigger fires, and the
  aggregate's `create()`/`fromSnapshot()` contract is checked for real.
- When Notifications or another context reacts to `AccountRegistered`: that is the trigger of a reaction, and the
  event then crosses a context, which is a published-language decision (CTX-PUBLISHED-LANGUAGE).
- When tokens need an expiry, or when several databases (not one file) must hold the accounts.
