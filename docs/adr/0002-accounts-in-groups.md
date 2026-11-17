# 2. Accounts in Groups: an aggregate and a domain event, brought in by this decision

## Context

Request 1 (accounts) is the first feature. Its storm (`conventions/storms/accounts.yaml`), decided with the product's
owner, puts the accounts in Groups (ADR 1, T1), makes `SignUp` a command answered at once, `GetMyAccount` a query, and
records that signing in is not a fact of the domain. It names two things the Lite profile (ADR 40) does not bring in by
default: an aggregate, `Account`, that `SignUp` creates, and a domain event, `AccountRegistered`, that the storm lists
as Groups' event.

The Lite profile says both come in "where a trigger fires, by an ADR". Neither trigger fires here:

- `reacts-to-domain-event` — nothing in Groups reacts to `AccountRegistered` yet; Notifications, the one context that
  will, is declared at checkpoint 2.
- `several-writers` — only `SignUp` writes an account; no two commands reach the same aggregate.

The rules the two triggers would hold (`DOMAIN-RECORDS-EVENTS`, `DOMAIN-CREATE-VS-RECONSTITUTE`, `CONC-OPTIMISTIC`) are
therefore not held by the binding here, and the code keeps to them by hand where it is cheap.

## Decision

- **`Account` is an aggregate of Groups** (`Domain/Account/Account.ts`), extending the building blocks' `AggregateRoot`.
  It is made by `create()`, which validates nothing itself (its decision does) and records `AccountRegistered`;
  it is rebuilt by `fromSnapshot()`, which records nothing and throws on corrupted data. Its id is born once, in
  `Id.generate()` in the decision, and never changes.
- **`AccountRegistered` is a domain event of Groups**, recorded by `Account.create()` and published through
  `publishDomainEvents()` after the save, as Full does. Nothing subscribes to it yet; when a context reacts to it, the
  trigger fires and this ADR is revisited.
- **Signing in is a query, not a command**: it checks the password and answers a token, and changes nothing. The
  token is signed (HMAC-SHA256 over the account id and a random nonce, with a key generated once and kept in the
  database), so a token needs no session row, and a server started again on the same file accepts the tokens it issued.
- **Passwords are hashed with scrypt** in the infrastructure, behind the port `IPasswordHasher`; the domain receives
  the hash as a value. Randomness (the salt, the token's nonce, the signing key) lives in the infrastructure, behind
  ports named for what they decide.
- **Persistence is SQLite**, through `node:sqlite`, in the file `DATABASE_PATH` names. The email is stored normalised
  (trimmed, lower case) under a unique index, so two servers on one file cannot both register the same email: the
  decision refuses the common case, and the index refuses the race (the repository's `insert` answers `false`).
- **Refusals**: an email in use is `EmailAlreadyUsed` (`400` at once, through the transport's mapping of a rule's
  exception). A wrong password and an unknown email are the same `NotAllowed` answer, `401` for an anonymous caller.

## Consequences

- Lite's aggregate and event rules are not enforced by the binding for Groups; the reviewer holds them. A context that
  reacts to `AccountRegistered`, or a second command that writes accounts, brings the triggers in and must revisit this ADR.
- A token is valid until its account is removed; there is no sign-out yet. The signing key lives in the database, so
  whoever can read the file can mint tokens.
- A refused email, a short password, an empty name all answer `400` at once: the API allows `4xx` for a value refusal.

## When to revisit

When Notifications reacts to `AccountRegistered` (checkpoint 2), or when a second command writes an account (for
example, changing a name), whichever comes first.
