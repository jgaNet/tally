# 28. A contested settlement is held by its book, decided by an administrator, and logged by the context that decided it

## Context

Request 33 of Tally: the payee of a settlement paid through the provider says the money did not reach them. Until an administrator decides,
the settlement is held: the balances do not count it, but what its payer owes and what its payee is owed still count it as paid, and the
payer and the payee cannot leave the group, nor the group be archived or merged. An administrator decides it was paid (it counts again, as
before) or not paid (it is annulled, and what was owed is owed again). Every decision is in the administrators' log, which only
administrators read. The storm (`conventions/storms/contest-a-settlement.yaml`, decided before the run) put each decision where it belongs:
the book of Settlements decides the contest and the decision, the role of an administrator is given at sign-in to the account whose email
is in `ADMIN_EMAILS`, and the log is written by Settlements and read by Groups through a port Groups owns.

## Decision

- **No new context and no new relationship.** The relationship Settlements → Groups already carries `WaitingPayments` (ADR 15), and the
  storm adds the contract `AdministratorDecisions` to it: the map (`conventions/domain.yaml`) says so in its `why`. Settlements → Ledger carries
  `SettledAmounts` and `SettlementAudit` unchanged: a contested settlement is not `paid` or `refunding`, so the balances count nothing new.
- **The administrator is a role given at sign-in.** Groups' `Account.roleFor` decides it: an account whose email is one of the administrators'
  emails, whatever its case, signs in with the role `ADMIN`; every other account with `USER`. The token carries the role with the account, so
  the transport gives each request its caller and its role (`ExecutionContext`), and nothing in the API gives a role: sign-up takes no role.
  A token is now the signed claims `{ accountId, role }` in place of the bare account id; a token an earlier server signed, the bare id, still
  proves its account as a user, so nobody is signed out by this change.
- **Contesting and deciding are the book's.** `SettlementBook.contest` moves a `paid` settlement through the provider to `contested` (and records
  `SettlementContested`), only for its payee, once for a settlement (the settlement keeps `contestedAt`), and only while its payer and payee are
  members. `SettlementBook.decideContest` moves a contested settlement to `paid` (`SettlementPaid`) or `annulled` (`SettlementAnnulled`), and
  only a contested one, once. A contested settlement counts in `waitingOf`, so the balances' `stillOwed` treat it as paid and the Group's
  `WaitingPayments` refuses a leave, an archive and a merge, and it counts in neither `SettledAmounts` nor the statement's counted settlements.
- **The administrators' log is written in the decision's transaction.** Settlements keeps `administrator_log` (one row per decision, its id the
  settlement's with the decision, so a second write meets the primary key). `DecideContest` writes it in the same transaction as the settlement and
  its audit entry. Groups' `GetAdministratorsLog` reads it through `IAdministratorDecisions`, a port Groups owns, answered by
  `AdministratorDecisionsFromSettlements` over Settlements' read model (`IAdministratorLogRoster`), oldest first. No integration event: the entry is
  there as soon as the decision is answered.
- **Two audit entries, by the change's own identity.** `settlement-contested` (by the payee, with the amount) is written by `ContestSettlement`. A
  decision that the money arrived writes `settlement-paid` by the administrator, with the identity `settlement-decided-paid:<settlement>`: the
  settlement's first `settlement-paid` (`settlement-paid:<settlement>`) is kept, so both entries exist. An annulled settlement writes no entry.
- **Refusals are named by what the caller may know.** A contest by a member who is not the payee is `403`; a contest that the rules refuse, or
  one for a settlement or a group the caller is not in, is `422` or `404` as for a refund. An administrator's read of the contests and of the log
  that a non-administrator asks for is `404`: it does not exist for them. A decision asked by a signed-in non-administrator is `403`, and by no one
  at all is `401`, as the transport gives every command that needs a caller.
- **A decision is answered `204`**, with the settlement's new status read as `GET /v1/settlements/{id}` reads it.

## Consequences

- `api/33-contest-a-settlement.yaml` is the fragment the routes answer. `status` gains `contested` and `annulled`, `history` gains them too, and
  the audit's `action` gains `settlement-contested`.
- The `settlements` table gains `contested_at`, added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every start. Its `status` check, the
  history's and the audit's `action` check gain the new values in the table's definition. As with ADR 27, a database created before this feature
  keeps the old checks: they are replaced by hand before a contest is made there. The new `administrator_log` is created as the others are.
- The statement lists each settlement its balances count from its latest `settlement-paid`, so a settlement decided paid after a contest is listed
  once, with the time it counted again.
- `ADMIN_EMAILS` is read by the composition root (`createApplication`), as the other settings are. Without it there is no administrator.
- Not separately tested across two servers: the decision's settlement, its audit entry and its log entry are written by one transaction, and the
  book's version check serializes it with any other change, as before (ADR 10, ADR 25).

## When to revisit

If administrators are to be given by something other than an email list, the role moves from the sign-in to a store the account keeps, and
a token is checked against it. If the log is read by many, it moves to its own read model with paging.
