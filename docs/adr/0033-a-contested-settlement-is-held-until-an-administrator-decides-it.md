# 33. A contested settlement is held by Settlements until an administrator decides it, and the decision is logged by the context that made it

## Context

Request 33 lets the payee of a settlement paid through the provider say the money did not reach them. Its effect on the balances is held,
and it waits, until an administrator decides it was paid or annuls it; every decision is in the administrators' log, which only
administrators read. The storm of the feature (conventions/storms/contest-a-settlement.yaml) decided where each part lives: the role in
Groups' Account, the contest and its decision in Settlements' SettlementBook, and the log written in the decision's transaction, read by
Groups through a port it owns.

## Decision

- **An administrator is an account whose sign-in gave it the role.** `Account.roleAmong(administratorEmails)` says ADMIN when the account's
  email (lowercased, as Email keeps it) is one of the emails in `ADMIN_EMAILS`, and USER otherwise. Signing in answers a token that carries
  the account and that role, and the transport puts both on the request (`request.auth`). No command makes an administrator: the list is
  read when a sign-in is made (`administratorEmailsOf()`), so a change of the list reaches the next sign-in, not the tokens already issued.
- **A handler asks the role where it is defined.** `GetAdministratorsLog`, `GetContests` and `DecideContest` read `context.auth.role` against
  `Role.ADMIN` in their own file. Anyone else signed in is refused: a decision with `403` (`NotAllowed`), a list that only an administrator
  reads with `404` (`NotFound`, as it does not exist for them). An anonymous call is refused by the transport with `401`, as every query that
  needs a caller.
- **A contest is a state of the SettlementBook.** `ContestSettlement` moves a paid settlement through the provider to `contested` (only its
  payee, once, while both members are in the group, the group not archived), with the audit entry `settlement-contested` and the event
  `SettlementContested`. `DecideContest` moves it back to `paid` (the audit entry `settlement-paid` by the administrator, `SettlementPaid`) or to
  `annulled` (`SettlementAnnulled`, no audit entry). A decision is made on a contested settlement only, so once.
- **The held effect is the existing one for waiting money.** The balances count `paid` and `refunding` settlements only, so a contested one
  adds nothing to them (Ledger changes nothing). The book counts a contested settlement as paid in the amounts still owed (the same as a
  pending one), the suggestions and the debts read the same totals (`waitingOf`), and Groups refuses to leave, archive or merge while a payment
  of a member is `contested`, as for a pending or refunding one (`providerWaitingOf`). A webhook about a contested payment changes nothing.
- **The log is Settlements' and is written with the decision.** The book keeps each decision it made since it was read, and the store writes
  each row in the transaction of the decision (`administrator_decisions`), with the optimistic check of the book. There is no integration
  event: an entry is there as soon as the decision is answered.
- **Groups reads the log through a port it owns.** `IAdministratorDecisions` is Groups' port on the Settlements → Groups relationship, answered
  by `AdministratorDecisionsOfSettlements` over Settlements' read model, in the composition root's read model like `WaitingPayments`. Groups
  keeps no copy of the log.

## Consequences

- The relationship Settlements → Groups now carries two owned ports: `WaitingPayments` (request 20) and `AdministratorDecisions` (this request).
  The map is declared in conventions/domain.yaml, whose text names both.
- A token issued before this change has no role and proves a user: no account becomes an administrator by an old token.
- A contested settlement cannot be refunded (its status is not `paid`), and an annulled one is never counted nor waiting again.
- The administrators' log is not per group, and is never changed or removed, by any request.

## When to revisit

If the platform needs more roles than administrator and user, or a role that changes without a new sign-in, the role moves from the token to
a check at each request, and the decision above says so. If a decision must be undone, or a contest must be refused after an administrator
decides, a new decision says so: the statuses, the log and the held effect change together.
