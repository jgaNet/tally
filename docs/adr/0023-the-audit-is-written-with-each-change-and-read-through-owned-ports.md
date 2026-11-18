# 23. The audit is written by each context in the transaction of its own change, and Ledger reads it through two ports it owns

## Context

Request 28 of Tally (every change of money is an entry of its group's audit, with who made it, when, what, about which thing, and how much; a
member reads the group's audit, the oldest first) was stormed before the code (`conventions/storms/audit.yaml`, decided with the product's
owner). The storm decided that each context writes its own entries in the transaction of the change, from its aggregate's facts: Ledger for
expenses, Settlements for settlements, Groups for a balance passed. Ledger's audit query reads the other two through ports it owns over their
read models. An entry must be there as soon as the change is answered, which a fact relayed after the commit would not promise (T18).

Two relationships the map already declares carry what the audit needs: Settlements → Ledger (`SettledAmounts`, ADR 10) and Groups → Ledger
(`GroupMembers`, ADR 6). The storm adds one contract to each: `SettlementAudit` on the first, `PassedBalances` on the second.

## Decision

- **No new context and no new relationship.** Two contracts join two existing owned-port relationships, each named in the map's `why`
  (`conventions/domain.yaml`), and carried by one port Ledger owns and one adapter over the other context's read model. No integration event,
  and no change to the published language: the entries are read, not announced.
- **Each context writes its own entries.** Ledger has `ledger_audit`, written by `RecordExpense`, `EditExpense`, `DeleteExpense` and the
  reaction that records a recurring expense's day (`expense-recorded`, `expense-edited`, `expense-deleted`, with the payer as `by`). Settlements
  has `settlement_audit`, written by `RecordCashSettlement` (`settlement-paid`, by the payee) and by `ReceivePaymentWebhook` when the provider
  says a payment succeeded (`settlement-paid`, by the payer) or is refunded (`settlement-refunded`, by the payee). Groups has `group_audit`,
  written by `LeaveGroup` when the balance is not 0 (`balance-passed`, by the member who left, with their balance as they left). A refused change,
  a payment asked for or failed or refunding, and a webhook that changes nothing write no entry.
- **Identity follows the change.** An entry's id is the change's own identity, not a fresh random one: `expense-recorded:<expense>`,
  `expense-deleted:<expense>`, `expense-edited:<expense>:<version it was made from>`, `settlement-paid:<settlement>`,
  `settlement-refunded:<settlement>`, and `balance-passed:<group>:<position of the pass>`. Each change happens once, so its id is unique, and the
  primary key refuses a second write of it: a change has one entry however many servers run (DOMAIN-IDENTITY is kept by the change, which
  carries its own id).
- **Ledger reads through two ports it owns.** `ISettlementAudit` is answered by `SettlementAuditFromSettlements` over Settlements' roster
  (`ISettlementRoster.auditOf`), and `IPassedBalances` by `PassedBalancesFromGroups` over Groups' roster (`IGroupRoster.auditOf`). No domain
  imports another context. Each adapter is Ledger's infrastructure, as `SettledAmountsFromSettlements` is (ADR 10).
- **The query** `GetGroupAudit` (`GET /groups/{id}/audit`) answers the group's current members the entries of all three contexts, oldest first
  (by `at`, then the order the contexts answer), with `{ id, at, by, action, subjectId, amount }`. To anyone else the group does not exist: the
  group's `404`. The entries are never changed or removed: a deleted expense's entries stay, and a leaver's stay.
- **Each write is in the transaction of its change**, through the store's own writer, so a change refused is rolled back with its entry and a
  change answered as done has its entry even when the server is stopped right after it.

## Consequences

- The Lite profile holds: the audit's aggregates are the ones already there (Expense, Settlement, Group); the audit is a table each context writes,
  not an aggregate, since no decision depends on it.
- `api/28-audit.yaml` is the fragment the route answers: the entries as `{ id, at, by, action, subjectId, amount }`, the oldest first.
- `ledgerWiring` takes the two ports, which the composition root builds over the database alone, so no wiring needs another module to exist
  (ADR 1 T3, T5).
- The storm `conventions/storms/audit.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
- Not separately tested across two servers: the database's writer serializes the change and its entry, as it serializes any change (ADR 8, ADR 15).
