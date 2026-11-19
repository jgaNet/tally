# 25. Suspending an account, and where its refusals are decided

Status: accepted (request 34)

## Context

An administrator (request 33, ADR 24) must be able to stop an account while what it did is looked into: it may not start an
expense, a recurring expense, a cash settlement, a payment through the provider or a netting, in any group, and it must still
be able to read, edit, leave, refund and contest. Nothing in any group may change when the suspension starts or ends, and each
suspension and reinstatement is an entry of the administrators' log.

## Decision

- **Where a suspension is.** On the `Account` in Groups: a `suspended_at` moment on the account's row, set by `suspend()` and
  cleared by `reinstate()`. Each returns whether it changed, so an account already suspended (or not suspended, for a
  reinstatement) records nothing and writes no log entry.
- **One rule's name.** The refusal is `AccountSuspended`, a word of the shared kernel decided once by the Account, as
  `GroupArchived` is (ADR 20). No other context keeps a copy of the flag.
- **How the others ask.** Ledger and Settlements ask Groups through the ports they already own (`GroupMembers`,
  `SettlementMembers`), with `isSuspended(accountId)`, answered over Groups' read side. The caller of each command is asked
  when it runs, in its transaction, and the aggregate refuses: `Expense.create` (recording an expense),
  `RecurringExpense.setUp`, `SettlementBook.recordCash`, `SettlementBook.proposePayment` and the netting's refusal. Editing,
  deleting, leaving, refunding and contesting are not refused. A payment a suspended member receives is not refused either:
  it is the payer who asks.
- **Recurring expenses wait.** The background job skips a recurring expense whose payer is suspended, as it skips an archived
  group: the day is not recorded and stays next, so the first run after a reinstatement records every day that has come.
- **The log.** Groups writes its own entries (`account_administration_log`) in the transaction of each change, and its
  administrators' log reads them together with Settlements' decisions (AdministratorDecisions), the oldest first. No new
  context and no new relationship: the three links were already declared in the context map.

## Consequences

- A suspension is read by every context from Groups' read side, so a suspension decided in a command's transaction is seen by
  the commands that run after it, and not by one already decided.
- Nothing is copied: there is no flag in Ledger or Settlements that could fall out of step with Groups.
