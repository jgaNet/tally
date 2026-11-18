# 21. The audit of money changes: each context keeps its own changes, Ledger reads them through two ports it owns

## Context

Request 28: every change of money in a group is an entry of its audit (who, when, what, about what, how much), written with
the change, never changed, and read by a member of the group, the oldest first. The changes are made in three contexts: the
expenses (Ledger), the settlements (Settlements) and a balance that passed to the owner when a member left (Groups). The storm
(`conventions/storms/audit.yaml`) decided the hot spots before the run.

## Decision

- **No new context, no integration event.** The audit is read by Ledger, so Ledger asks each of the other two through a port it
  owns, in its own words: `SettlementAudit` (over Settlements' read side) and `PassedBalances` (over Groups' read side). The
  relationships are the ones the map already declares: `Settlements → Ledger` (SettledAmounts, ADR 7) and `Groups → Ledger`
  (GroupMembers, ADR 3). Each gains one contract; neither gains a link. An integration event was reconsidered (T8, T18): an
  entry must be there as soon as its change is answered, which a fact relayed after the commit would not promise.
- **Each context writes its own changes, in the transaction of the change.**
  - *Ledger* keeps the expenses' changes in `ledger_audit_entries`. A deleted expense's row stays. Its handlers write the entry
    after the save, so a refused change has none. The recurring expense's day writes one too, by its payer.
  - *Settlements* writes nothing new. Its history (`settlement_history`, request 19) already holds a row for every status a
    settlement has had, written in the transaction of the change. Its read (`ISettlementAuditEntries`) reads that history:
    a `paid` status is `settlement-paid` (by the payee for cash, by the payer through the provider), and a `refunded` status is
    `settlement-refunded` by the payee, but only for a settlement that had been paid, since one refunded from `pending` changed
    no balance.
  - *Groups* writes nothing new. A leave already writes its passed balance to `group_balances_passed` (request 20), in the
    leave's transaction. Its read (`IPassedBalanceEntries`) answers it; a balance of 0 is no entry.
- **Ids are the change's own.** An expense's entry is `<action>:<expense>:<version>`, the version the change was made from, so
  the same change is one entry however many servers write it. A settlement's and a balance's entry carry the row that records
  them, which is written once.
- **Reading.** Ledger's `GetGroupAudit` answers a member of the group, the oldest first (ISO times in UTC sort as the instants
  do). For anyone else the group does not exist. Ledger's own part is read outside any transaction, as its other queries.
- **The wiring.** Ledger's module imports the two read exports (`settlementAuditEntries`, `passedBalanceEntries`) directly, as
  it already imports `settlementEffects` and `groupMembership`; the composition root is unchanged.

## Consequences

- The storm's hot spot says Settlements writes its entries; they are written as the settlement's history, which is the same
  transaction and the same facts. The audit reads a fact and never copies it, so nothing can disagree with the settlements.
- A context that changes money without writing its change in its history or the audit table is a gap the e2e scenario must
  catch: the scenario covers every change in the table of request 28.
- No row is ever updated or deleted in the audit tables, so the query needs no filter for deleted expenses.

## When to revisit

When an entry must say why a change was made (a reason is a new fact in each context, not a field of this read), or when a
change of money is made by a context that does not keep a history (then it writes its own entry, as Ledger does).
