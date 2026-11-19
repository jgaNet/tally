# 31. A contested settlement waits for an administrator, whose role is given at sign-in

## Context

Request 33 lets the payee of a settlement paid through the provider contest it, and lets the platform's administrators decide. It adds three
things the application did not have: a role, the administrator; a status that waits without counting (`contested`); and a log only
administrators read. The storm (`conventions/storms/contest-a-settlement.yaml`) decided where each lives; this records how.

## Decision

- **An administrator is a role of the caller, given at sign-in.** Groups holds accounts, so its `isAdministratorAccount` (a pure function of an
  account and the emails the server was started with, `ADMIN_EMAILS`, compared whatever the case) decides it when the account signs in. The
  token carries it, inside what is signed (`accountId.nonce.administrator.signature`), and the transport gives the request `Role.ADMIN`
  instead of `Role.USER` (`ExecutionContext.auth.role`). No command makes an administrator; a token cannot be given the role by editing it.
  `ADMIN_EMAILS` is read when a sign-in comes, as the other environment is.
- **The use cases that only an administrator may call check the role themselves.** `DecideContest` answers a caller who is not one with
  `NotAllowedException` (403). The two reads (`GetContests`, `GetAdministratorsLog`) answer a caller who is not one as for something that does
  not exist (404): what only an administrator reads does not exist for anyone else. A missing caller is the transport's 401.
- **A contest is decided in the SettlementBook.** `contest` moves a paid settlement to `contested` (`SettlementContested`); `decideContest` moves
  it to `paid` again (`SettlementPaid`) or to `annulled` (`SettlementAnnulled`). A contested payment stays live in the book, so a refund is asked
  of the same provider payment after it is paid again; an annulled one is no longer held.
- **A contested settlement waits and is not counted.** `SettledAmounts` answers the paid and refunding settlements only, so the balances do not
  count it and Ledger changes nothing. The book's `stillOwed`, the read model's `pendingOf` and `hasWaitingPayment` count it as waiting, so what its
  payer owes and its payee is owed treat it as paid, and Groups' `WaitingPayments` refuses leaving, archiving and merging while it lasts. A webhook
  about its payment changes nothing.
- **Contested once, decided once.** The decision reads the settlement's history: a settlement that has been `contested` is never contested again,
  even after it was decided paid; only a `contested` settlement is decided, and it is no longer after.
- **The administrators' log is written by Settlements in the transaction of the decision**, as the audit is made of the history (ADR 25): the book
  records its entries and `save` stores them with the status. Groups reads them through a port it owns, `AdministratorDecisions`, answered by an
  adapter over Settlements' read model, on the relationship Settlements → Groups that `WaitingPayments` already carries. No integration event:
  an entry is there as soon as the decision is answered.
- **The audit** names `settlement-contested` (by the payee, with its amount) from the history's `contested` line, and `settlement-paid` by the
  administrator from the `paid` line a decision writes, which stores who decided it (`settlement_history.by_account`). A settlement annulled is
  no other entry.

## Consequences

- A token issued before this request is valid and names a user: nobody is made an administrator by an old token, and an administrator signs in
  again after `ADMIN_EMAILS` changes to hold the role for the new list.
- The role is a fact of the token until it is used up: an account removed from `ADMIN_EMAILS` keeps the role until it signs in again. A token has
  no expiry in Tally today (ADR 1), so this is the same as every other claim in it.
- `settlement_history` gains a nullable column and the log has a table of its own; both are made idempotently by the Settlements database's set-up.

## Revisit when

- Administrators change often enough that the role must be read from the account on every request, or a token expires.
- A second kind of decision joins the log: the entries' `action` is then a larger set, and Groups' port is its reader (request 34).
