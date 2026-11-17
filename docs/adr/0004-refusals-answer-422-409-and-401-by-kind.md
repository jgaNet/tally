# 4. Refusals answer 422 for a rule, 409 for a conflict, and 401 for a refused proof

## Context

The API's conventions give `400` to a body missing a field or with a field of the wrong type, and `401`, `403`, `404`,
`409` or `422` to every other refusal, as fits. The Lite transport answered every rule's refusal with `400`, and a
conflict with `409` only for a concurrency conflict. Two of request 1's answers do not fit that: an email already
registered is a conflict (`409`), and a wrong password answers `401` on the login route whoever asks, where
`NotAllowedException` answers `403` to a signed-in caller.

## Decision

- **A rule's refusal is `422`** (a value the domain refuses: an email that does not look like one, a name or a password
  out of its range). `400` stays with the body's shape, which the transport refuses before any use case runs.
- **A conflict with what is kept is `409`**: `ConflictException` (a base for a context's own conflicts, such as an email
  already registered), beside the `ConcurrencyConflictException` that already answered `409`.
- **A refused proof is `401` on every route**: `UnauthenticatedException` (a wrong password, or an email no account has),
  whoever is asking, so the same answer tells nobody which emails have accounts.
- The building blocks' `CommonExceptions.ts` and `AnswerAtOnce.ts` hold these; the transport's spec states each.

## Consequences

- A Lite route's rule refusal that answered `400` now answers `422`. The transport's spec is updated; no other context
  existed to change.
- Every context's own exceptions choose their base: a conflict extends `ConflictException`, a refused proof
  `UnauthenticatedException`, a missing thing `NotFoundException`, and any other rule is `422` by default.

## When to revisit

When a refusal needs a status none of these kinds gives (for example `423` or `429`): a new kind of exception and a new
line in `refusalStatus`, decided here.
