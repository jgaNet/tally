# 2. One SQLite file for what the application knows (superseded by ADR 21)

## Context

The first feature (accounts) is the first that must outlive the process: a server stopped, even abruptly, and started
again on the same file finds every account and every operation its clients were answered, and several servers may run
on the same file at once. The building blocks only had in-memory adapters (the stores, the unit of work, the outbox),
and the Tracker kept its operations in memory.

## Decision

- **One file, `DATABASE_PATH`, one connection per process** (`SqliteDatabase`, with Node's built-in `node:sqlite`; no
  dependency). Without the variable the data lives in memory, which is what the unit and end-to-end suites use. The
  journal is write-ahead and a writer waits for the one before it, so servers on the same file queue instead of failing.
- **The building blocks gain the SQLite adapters of their ports**: `SqliteUnitOfWork` (a `BEGIN IMMEDIATE` transaction)
  and `SqliteOutbox` (the events of an aggregate are appended in the same transaction as its state, and relayed after
  the commit and again at the next start, EVENT-AFTER-COMMIT). The in-memory adapters stay, as the doubles of the specs.
- **One transaction at a time inside a process.** The connection is shared by every request, so a transaction holds a
  lock until it ends, and whoever writes or reads outside one (the outbox's relay, the Tracker's records, the read
  models) goes through `exclusive()` and waits for it. Nothing in a transaction waits for anything but the file: the
  password hash is synchronous for that reason.
- **Every context keeps its own tables in the file**: `accounts` (Groups), `operation_records` (Tracker, so that an
  operation is found on whichever server is asked, and after a restart), and the building blocks' `outbox`. The email
  is unique in the file, so two sign-ups at once cannot both win, on one server or two.
- **The token is stateless**: an HMAC-signed account id and expiry, signed with a secret the file keeps once for every
  server on it (`SqliteDatabase.setting`). It names its account on any server and after any restart.
- **The shared kernel's `Email`** accepts what the product says an email is: something, `@`, something with a dot.
- **The operation is read at `GET /v1/operations/{id}`** (the Tracker's path also stays), and an operation that was
  never recorded is `404` for an anonymous caller too: a client that is told to sign in learns that the operation
  exists. A transport answers a field of the wrong type with `400` rather than converting it.

## Consequences

- A command is accepted (`202`) before it is decided: a server killed in between leaves the operation `PENDING`; what a
  decided command made durable is never lost, and its events are published at the next start.
- Two servers may both relay an outbox entry neither has marked yet: a subscriber may see a fact twice, which
  EVENT-AFTER-COMMIT already says. Today nobody subscribes to `AccountRegistered`.
- Reading a stale connection is impossible, but a long transaction stalls every other writer of the file: handlers keep
  to short work.

## When to revisit

When a reaction needs exactly-once delivery across servers (an outbox entry would then be claimed before it is
published), or when a second database engine is asked for (the unit of work and the outbox are the two ports to answer).
