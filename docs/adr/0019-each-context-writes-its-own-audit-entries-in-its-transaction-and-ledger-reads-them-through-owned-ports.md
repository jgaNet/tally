# 19. Each context writes its own audit entries in the transaction of its change, and Ledger reads them through ports it owns

## Context

Request 28 gives a group an audit: every change of money is an entry, with who made it, when, what it was about and how much, the oldest
first, and never changed. The changes are made in three contexts: an expense is recorded, edited and deleted in Ledger; a settlement is
paid or refunded in Settlements (in cash when it is recorded, through the provider when its webhook says so); a balance is passed to the
owner when a member leaves, in Groups. The storm (`conventions/storms/audit.yaml`) decided that each context writes its own entries in the
transaction of the change, that Ledger's audit query reads the other two through ports it owns over their read models, and that an entry
follows a fact recorded once. An integration event was considered for the entries and not taken: a fact relayed after the commit would not
promise that the entry is there when the change is answered (T18).

## Decision

- **Each context writes its entries in its own table, in the transaction of the change.** Ledger's `audit_entries` holds the expenses'
  entries (`expense-recorded` in `RecordExpense`, `expense-edited` in `EditExpense`, `expense-deleted` in `DeleteExpense`, and the recorded
  day of a recurring expense in `RecurringExpenseDayCame`). Settlements' `settlement_audit_entries` holds `settlement-paid` and
  `settlement-refunded`, written by the book's own record of the money it moved (`SettlementBook.moneyMovedSinceRead`): a cash settlement is
  paid when recorded, a provider's when the webhook says it succeeded, and a refund when the webhook says it is refunded, and only when it was
  counted before (paid, or being refunded). Groups' `group_audit_entries` holds `balance-passed`, written in `LeaveGroup` when the balance is
  not 0.
- **Ledger's audit query reads the three through ports it owns.** `ISettlementAudit` (over Settlements' read model, `ISettlementAuditQueries`)
  and `IPassedBalances` (over Groups' read model, `IGroupAuditQueries`) are the two contracts the existing links to Settlements and to Groups
  now carry, so the relationships in the context map are unchanged (ADR 4, ADR 7). `GetGroupAudit` checks membership first, as every query
  of the group does, and orders the merged entries by their time, the stable order keeping each context's own order for equal times.
- **`by` is the member the change acts for.** An expense is by its payer when a recurring day records it, and by the caller otherwise; a cash
  settlement by its payee, who recorded it; a provider's payment by its payer; a refund by its payee; a balance passed by the member who left.
- **An entry's id names the change, so the same change is never written twice.** An expense is recorded once (`expense-recorded:<id>`) and
  deleted once (`expense-deleted:<id>`); an edit is named by the version it was read at, which is consumed once, since two edits can not both
  read it and succeed (`expense-edited:<id>:<version>`); a settlement moves money once each way; a member leaves a group once per instant of
  the leave. A change that records nothing (a webhook said twice, a redelivered recurring day, a refused command) writes no entry, because the
  transaction that would write it is refused or finds the fact already recorded.
- **No new context and no new relationship.** The storm's links are two that the map already declares, Settlements to Ledger and Groups to
  Ledger, each carrying one more contract. The feature needed no architecture change beyond that.

## Consequences

- An entry is stored in the transaction of the change, so a server killed after the change is answered keeps its entry, and a change that is
  rolled back keeps none. Several servers on one file write one entry per change, since the change itself is written once (CONC-OPTIMISTIC).
- Entries are never changed or removed: no command writes to an existing row, and a deleted expense keeps its entries.
- A context that makes a new kind of money change adds its own entries and its own read-model port; Ledger's query needs no change except to
  merge the new port, which is one line.
- The ids are derived from the changes, not generated: the entries need no identity of their own (an audit row is written by the change, once),
  and a repository never hands one out.

## When to revisit

If an entry should be written for a payment asked for, failed or refunding, or for a budget or a receipt (the request says it is not), that
is a new request and a new kind of entry in the owning context. If the audit grows large, its read is paged in the owning contexts first, and
Ledger's merge is revisited with it.
