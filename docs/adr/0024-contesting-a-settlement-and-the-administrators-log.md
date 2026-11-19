# 24. Contesting a settlement: the book decides, the administrators are a role of the caller, and the log is each context's own

## Context

Request 33: the payee of a settlement paid through the provider says the money did not reach them. The settlement is then
held: the balances do not count it, it waits as a pending payment does, and an administrator decides it was paid (it counts
again) or not paid (it is annulled, and what was owed is owed again). Every decision of an administrator is in the
administrators' log, which only administrators read. The storm (`conventions/storms/contest-a-settlement.yaml`) decided the
hot spots before the run; this ADR records the architecture it needs (the session's T21, T24 and T25, ADR 23).

## Decision

- **No new context and no new relationship kind.** The contest is decided in the `SettlementBook` (T24), as every settlement
  is. What is new is one contract on a relationship the map already declares: Settlements answers Groups through a port Groups
  owns, `AdministratorDecisions`, beside `WaitingPayments` (the link Settlements → Groups, owned-port). The map's `why` says so.
- **An administrator is a role of the caller** (T21, the storm's first hot spot). Groups' Account decides it: at sign-in, the
  account whose email is in `ADMIN_EMAILS` (a comma-separated list the server is started with, compared without case) is
  given the role `ADMIN`; every other account `USER`. The token carries that role, signed with the account id, so the caller's
  role travels with it as `ExecutionContext.auth` does. Nothing in the API makes one. A token of the earlier shape (before
  roles) proves a user, so an administrator who held one signs in again.
- **The administrators-only handlers guard on the role in `guard()`** (the framework's authorization hook, the way the
  Tracker's operation list does): `DecideContest` (a command, refused as its operation's ERROR behind the 202),
  `GetContests` and `GetAdministratorsLog` (queries, refused at once: 401 to a caller not signed in, 403 to a signed-in one
  who is not an administrator, through `notAllowedStatus`).
- **A contest is refused by the book, and kept by it** (T24): `SettlementBook.contest` refuses a caller who is not the payee
  (`NotThePayee`), a settlement that is not paid through the provider (`SettlementNotContestable`), one contested before
  (`SettlementAlreadyContested`, once for a settlement), a caller or a payer or payee who is no member of the group (the
  settlement does not exist, or `PayerNotAMember` / `PayeeNotAMember`), and a group archived (`GroupArchived`). A contested
  settlement is `contested` in its history. `SettlementBook.decideContest` refuses what is not contested
  (`SettlementNotContested`), and takes it to `paid` or `annulled`.
- **Contested waits and does not count** (the storm's second hot spot): `SettledAmounts` (the paid and refunding statuses)
  does not count `contested`, so Ledger changes nothing; the suggestions and the book's still-owing count it as paid
  (`WaitingEffects` and `stillOwing` include it); `WaitingPayments` counts it, so a member cannot leave, a group cannot be
  archived or merged, until it is decided. A webhook about it changes nothing: a webhook moves only a pending payment.
- **The administrators' log is each context's own entries** (the storm's third hot spot, T18): the decision is kept in the
  book's transaction, in the table `administrator_decisions`, with the settlement, the administrator, the time and the action
  (`decided-paid` or `decided-annulled`). Groups reads them through `AdministratorDecisions`, answered by an adapter over
  Settlements' read side that its wiring exports, and no integration event carries them: an entry is there as soon as the
  decision is answered. No request changes or removes one.
- **The audit has two entries more** (request 28, ADR 21): `settlement-contested` by the payee, with the amount, when the
  payee contests; and `settlement-paid` by the administrator when a contested settlement is decided paid. An annulled one has
  no entry: the balances stopped counting it at the contest.

## Consequences

- The contest and the decision are two commands with a version check each (CONC-OPTIMISTIC): a contest and a decision
  decided at once meet the book's version, and the second re-reads it.
- A removed administrator keeps the role in the token they already hold, until they sign in again: the token carries no
  expiry, as before this request. Removing an email from `ADMIN_EMAILS` takes effect at that account's next sign-in.
- The e2e scenario for the contest covers the holds, the decision, the log, the audit and every refusal, so a context that
  forgets `guard()` or `WaitingPayments` fails a test, not a user.

## When to revisit

If administrators must lose the role at once, the role is read from the account on each request rather than from the token,
and the sign-in's role is then the account's own question (T21's alternative). If a contest needs a reason or a deadline, the
contest becomes a fact with its own history (the storm's fourth hot spot is decided on the book's statuses, not on a reason).
