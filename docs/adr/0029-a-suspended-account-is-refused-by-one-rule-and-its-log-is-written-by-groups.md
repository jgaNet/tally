# 29. A suspended account starts nothing: Groups decides the suspension, the shared kernel names its one rule, and the administrators' log is written by Groups

## Context

Request 34 of Tally (an administrator suspends an account and reinstates it; a suspended account cannot record an expense, a recurring expense,
a cash settlement, a payment through the provider or a netting, in any group; its recurring expenses wait; nothing is written in any group;
each suspension and reinstatement is an entry of the administrators' log) was stormed before the code (`conventions/storms/suspend-a-member.yaml`,
decided with the product's owner). It follows the archive (ADR 22): one rule's name, decided once, asked by each context through the port it owns.

No context and no relationship are new. The three links the storm needs are already declared and carried by the map: Groups → Ledger
(`GroupMembers`), Groups → Settlements (`SettlementMembers`) and Settlements → Groups (`AdministratorDecisions`, request 33). Each of the first two
gains one answer, `isSuspended(accountId)`; the third is unchanged. What the log answers gains two actions, and Groups writes them itself.

## Decision

- **Groups decides, and the suspension is on the account.** The account aggregate holds `suspendedAt`, set by `suspend(now)` and cleared by
  `reinstate(now)`. Each is pure, and changes nothing (no save, no entry, no event) when the account is already in that state. Each records its
  fact, `AccountSuspended` or `AccountReinstated`, which nothing in another context subscribes to. The commands `SuspendAccount` and
  `ReinstateAccount` are answered at once (`PUT` and `DELETE /admin/accounts/{id}/suspension`, `204`). Only an administrator may (`403` to anyone
  else, and the account is not looked at); an account that is not there is `404`.
- **Groups writes the log, in the change's transaction.** The suspension and the account's new version are saved, and its entry (`suspended` or
  `reinstated`, the account as `subjectId`, the administrator as `by`) is written with it, into Groups' own table `administrator_actions`. A change
  that changed nothing writes no entry. The account's row carries `version` (CONC-OPTIMISTIC, as a group's does) and `suspended_at`; the schema
  adds those two columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a database made before them gets them.
- **One rule's name is a word of the shared kernel.** `AccountSuspendedException` and `ACCOUNT_SUSPENDED` live in `src/SharedKernel/Domain/AccountSuspended.ts`:
  the type is `AccountSuspended`, the status `422` (ADR 4), the same name for every refusal. The kernel imports the building blocks and no context.
- **Each context asks Groups through the port it owns, and its aggregate refuses.** Groups' `IGroupRoster` gains `isSuspended(accountId)`, answered
  from the account's row. Ledger's `IGroupMembers` and Settlements' `ISettlementMembers` gain the same answer over it. The use case reads the answer for
  the account that starts the change, inside its own transaction, and passes the boolean to the aggregate, which refuses with `AccountSuspended`
  (ordered after the group's own refusals, `GroupArchived` first):
  - the caller's expense (`Expense.register`, the payer is the caller) and the reaction that records a recurring day, for the payer;
  - the caller's recurring expense (`RecurringExpense.setUp`), for the payer;
  - the payee's cash settlement (`SettlementBook.recordCash`, the payee is the caller);
  - the payer's payment through the provider (`proposePayment`, and again in `recordPayment`);
  - the caller's netting (`Netting.make`, `bySuspended` in its draft), before anything is kept.
  Nothing else refuses a suspended account: editing, deleting, reading, leaving, refunding, contesting, splitting with it, and paying it are as before.
- **The background job waits.** The recurring expense's sweep answers `suspended` when its payer is suspended, and the sweep leaves it alone the way it
  leaves an archived group alone: no day is recorded, `next` does not move, nothing is saved. The first sweep after the reinstatement records every day
  that has come, as request 23's catching up does. The reaction that records a day also refuses a suspended payer, so a suspension that lands between a
  sweep and its reaction is refused by name rather than recorded.
- **The log is read from two sources.** `GetAdministratorsLog` answers Settlements' decisions (through the port it already owns) and Groups' own entries
  (through `IAdministratorActionLog`), merged oldest first by their time. Only an administrator reads it, as before.
- **Nothing is written in any group.** A suspension or its end writes no group row, member, balance, expense, settlement, or audit entry.

## Consequences

- No new context, no new relationship, no new integration event, and no change to the published language. `AccountSuspended` and `AccountReinstated`
  are domain events of Groups; nothing subscribes to them.
- The Lite profile holds: the account was already an aggregate (ADR 1), and the commands are answered at once and not later.
- Each changed aggregate method takes an explicit `payerSuspended` / `payeeSuspended` / `bySuspended` boolean, and the specs of those aggregates check the refusal.
- `api/34-suspend-a-member.yaml` is the fragment the routes answer; the log's `action` takes `suspended` and `reinstated`.
- The storm `conventions/storms/suspend-a-member.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
- A race between a suspension and a payment started at the same instant is serialized by the database's writer and each command's version check (ADR 8, ADR 25),
  as a group's changes are; this is not separately tested across two servers.
