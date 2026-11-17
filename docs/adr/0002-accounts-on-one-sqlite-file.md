# 2. Accounts in Groups, and the application's state in one SQLite file

## Context

Feature 1 (accounts) was stormed with the product's owner (`conventions/storms/accounts.yaml`): accounts live in
Groups (ADR 1, T1), signing in is not a fact of the domain, and a name belongs to the account. The application had
only in-memory stores, so an account would not survive a restart, and a server would not see the accounts another
server wrote. The product needs both: a server stopped abruptly and started on the same file finds every account
and every operation a request brought, and several servers may share that file at the same time.

## Decision

- **Groups is held to the default (Full) profile.** `Account` is the aggregate root: its creation records
  `AccountRegistered`. Sign-up is a command (`SignUp`, anyone may ask), reading one's own account is a query
  (`GetMyAccount`, a signed-in caller), and signing in is a query that answers a token and records nothing.
- **Sign-up is answered at once** (`201 { id }`, the product's table) by `acceptCommandAtOnce`, which publishes the
  command as `acceptCommand()` does and waits for its outcome for a deadline (the `awaitOperation` mechanic of
  ADR 36). A refusal answers at once with the rule's `type` (400, or 409 for an email another account uses). Past
  the deadline the answer is `202 { operationId }`, and the outcome is read at `GET /v1/operations/{operationId}`.
- **One SQLite file holds the application's state** (`DATABASE_PATH`, `tally.db` when it names none): every
  context's stores, the transactional outbox (ADR 24) and the operation records, so that a transaction's writes and
  its outbox entries commit or roll back together. `SqliteDatabase` keeps one connection per process and a turn at
  the file: a transaction holds the turn from its begin to its commit, and a read or write outside a transaction
  waits for it. Across processes, `BEGIN IMMEDIATE`, SQLite's locks and a busy timeout serialise the writes.
  `SqliteUnitOfWork` and `SqliteOutbox` are the second adapters of the framework's ports, beside the in-memory ones.
- **Passwords** are hashed with scrypt behind the `IPasswordHasher` port (a business meaning, an algorithm
  behind a port). **Tokens** are `<account id>.<HMAC-SHA256>`, the key kept in the file's `settings` table and
  created by the first server to open it, so every server on the file accepts what any of them issued.
- **The operation route** is `GET /v1/operations/{operationId}` and answers `{ status, result?, error? }`, as
  request 1's fragment (`api/1-accounts.yaml`) gives it. The scaffold's operation list is not part of the API and
  is not served.
- **Background job:** the server relays the outbox every `JOBS_INTERVAL_SECONDS` (60 when unset), which is where a
  fact a crash kept from being published goes out (ADR 24).

## Consequences

- A fact may be published more than once across servers that share the file: each relays the pending entries it
  sees, and the bus only recognises a message it delivered itself. Delivery is at least once, as the outbox states;
  a subscriber must tolerate a repeat.
- Writes are serialised: one transaction at a time per process and per file. For this application's size that is
  the simplest correct choice; a long transaction would hold the others up, so transactions hold no slow step.
- Tokens do not expire and cannot be revoked: the product's API says nothing of either.

## When to revisit

- When a feature needs tokens that expire, or a sign-out, the token needs state or a shorter life.
- When several servers relay the outbox often enough that duplicate publication costs something: the relay then
  claims the entries it hands out (a row lock or a lease).
- When request 2 or later asks for a command whose outcome is read later for every caller, the sign-up route can
  keep its at-once answer while other routes answer `202`.
