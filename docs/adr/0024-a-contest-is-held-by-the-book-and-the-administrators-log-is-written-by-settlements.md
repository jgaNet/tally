# 24. Administrators are a role given at sign-in, a contest is held by the settlement's book, and the administrators' log is written by Settlements and read by Groups through a port Groups owns

## Context

Request 33 lets the payee of a settlement paid through the provider contest it, holds its effect on the balances and on what is
still owed until an administrator decides, and records every decision of an administrator in a log that only administrators read.
The storm (`conventions/storms/contest-a-settlement.yaml`) decided four things: who is an administrator, where a contest is decided,
where the log is written and read, and what a contested settlement holds in Groups. This ADR records the one relationship the
storm adds to the context map, and the choices the code rests on.

## Decision

- **An administrator is a role, given at sign-in.** Groups' `Account` decides it (`roleOf`): the account whose email is one of the
  `ADMIN_EMAILS` the server was started with, whatever its case. The token the account is given carries the role; the transport puts
  it in the `ExecutionContext` next to the caller. No command makes an administrator. Handlers that only an administrator may call refuse
  with `isAdministrator` in `guard()`, and admin reads answer `404` to a signed-in caller who is not one, `401` to nobody.
- **A contest is decided in the SettlementBook.** `contest` moves a paid settlement through the provider to `contested`, `decide` moves a
  contested one to `paid` or `annulled`. A contested settlement waits, as a pending payment does: the book counts it as paid for what its
  payer still owes and its payee is still owed, the balances (`SettledAmounts`) do not count it, and `WaitingPayments` answers it as
  waiting, so the Group refuses a leave, an archive and a merge until it is decided.
- **The administrators' log is written by Settlements, in the decision's transaction** (as the audit is, T18). Settlements owns the port
  `AdministratorDecisionLog` it writes through, and answers the log to Groups through the read model it keeps.
- **Groups reads the log through a port it owns, `AdministratorDecisions`**, answered by an adapter over the read model Settlements exports.
  The relationship Settlements → Groups therefore carries two owned ports, `WaitingPayments` and `AdministratorDecisions`, both owned by
  the asking side (Groups), as the existing one is. No integration event: an entry is there as soon as the decision is answered.
- **Audit ids name the change by its place in the settlement's history.** A settlement paid by the provider and then paid again by an
  administrator is audited twice as `settlement-paid`; an id made of the action and the settlement alone would collide.

## Consequences

- The context map (`conventions/domain.yaml`) names `AdministratorDecisions` on the relationship Settlements → Groups, and the Groups
  language has the term Administrator.
- Tokens issued before this change carry no role and are read as signed in as a member, which is the role every account had before.
- An administrator's token keeps its role until it expires: a change to `ADMIN_EMAILS` takes effect at the next sign-in.
