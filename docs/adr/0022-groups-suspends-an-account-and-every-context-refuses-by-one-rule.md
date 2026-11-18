# 22. Groups suspends an account, and every context refuses by one rule (no new context, no new relationship)

## Context

Request 34 has an administrator suspend an account, and reinstate it, while someone records invented expenses in every group they are
in. While an account is suspended, the expenses, recurring expenses, cash settlements, payments through the provider and nettings it
starts are refused, in every group, by one rule's name, and change nothing. Its recurring expenses wait. Nothing is written in any group.
Each suspension and reinstatement is an entry of the administrators' log. The storm `suspend-a-member` decided four hot spots with the
product's owner: where a suspension is, how each context refuses it by one name, what the recurring expenses do, and where the log is
written. This ADR records what the storm left to the code. The links it needs already exist (ADR 5, ADR 7, ADR 11, ADR 21), so no context
and no relationship is added.

## Decision

- **Groups decides that an account is suspended.** `Account.suspend` and `Account.reinstate` are the two behaviours that record
  `AccountSuspended` and `AccountReinstated`. Each answers whether it changed the account: one already suspended (or reinstated
  one not) records nothing and answers false, and the command then writes no entry and saves nothing. The commands
  `SuspendAccount` and `ReinstateAccount` are answered only to an administrator (`Role.ADMIN`, the list `ADMIN_EMAILS` names); anyone
  else is refused with `NotAllowed` (403). No group is touched.
- **Every context refuses by `AccountSuspended`, a word of the shared kernel** (`AccountSuspendedException`, `SharedKernel/Domain`), a
  conflict (`409`) with the same `type` whatever the change, as `GroupArchived` is (ADR 18). No context keeps a copy of the flag.
  Each asks Groups through the membership port it already owns, by the account that acts: `IGroupMembers.isSuspended` for Ledger
  (`RecordExpense`, `SetUpRecurringExpense`), `ISettlementMembers.isSuspended` for Settlements (`RecordCashSettlement`,
  `PayThroughProvider`, `NetDebts`). The check runs after the caller is found a member, and before anything changes.
- **Its recurring expenses wait.** The background job asks Ledger's membership port for the payer of a recurring expense whose day has
  come. A suspended payer records nothing and the day stays next, so the first run after the reinstatement records every day that has
  come (request 23's catching up).
- **Nothing is written in a group.** A suspension or its end writes no group, no balance, no expense, no settlement and no audit entry.
- **The log.** Groups writes its own entries of the administrators' log, in the transaction of the change: `administrators_log` holds
  each suspension and reinstatement, its `action` `suspended` or `reinstated`, its `subjectId` the account, and the administrator as `by`.
  `GET /v1/admin/log` answers them beside Settlements' decisions (ADR 21), oldest first, through the port Groups already owns
  (`IAdministratorDecisions`, which now reads both sources).

## Consequences

- The shared kernel gains one exception, and the conventions name it with the other shared words.
- A suspended account still signs in, reads, edits or deletes its expenses, leaves a group, refunds or contests a settlement, and is
  still in every group's splits, as request 34 says.
- The check is on the caller's account, not on the group: a suspension reaches every group at once, and nothing is copied per group.
