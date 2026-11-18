# 20. A member's statement lists the settlements the balances count, and is read as CSV through a query of its own

## Context

Request 8 gave a member a statement of their expenses alone, and the settle-in-cash storm (ADR 7) decided that a settlement is not an
entry of it, so that the statement "differs from the group's balance by the settlements". Request 29 changes that: a member's statement
lists, beside the expenses, the settlements the balances count that they pay or receive, each with a `kind`, and the same statement is
read as CSV (`text/csv`, UTF-8, a stated column order). The storm (`conventions/storms/statement-as-csv.yaml`) decided two hot spots:
the statement learns of the settlements through `SettledAmounts` (ADR 7's port, which Ledger owns), and the CSV is the same statement
rendered by the transport. The storm also names a query `GetMemberStatementCsv` in Ledger, which the code must carry.

No context and no relationship between contexts is new: the link Settlements → Ledger (ADR 7) and Groups → Ledger (ADR 4) carry it.
So this is a change of the contract of an existing owned port, which the architecture mode records here.

Two things the statement needs were not in the code:

- **When a settlement started to count.** A cash settlement counts from its recording. A settlement through the provider counts from the
  moment it is paid, which Settlements keeps in its history (request 19), and it stops counting once it is refunded. A settlement that
  is refunded is therefore in no statement, as it is in no balance.
- **When an expense was recorded, to the moment.** An expense keeps only its recording order, and the statement must place a settlement
  among the expenses of its day by a moment that both kinds have. Ledger's audit entry `expense-recorded` (ADR 19) carries it, written
  in the transaction that records the expense.

## Decision

- **`ISettledAmounts` (Ledger) gains `countedOf(groupId, memberId)`.** It answers each settlement of the member that the balances count,
  with `countedFrom`: the instant the balances started to count it. Its adapter, `SettledAmountsFromSettlements`, answers it over
  Settlements' read model. The read model's port, `ISettledAmountsQueries`, gains the same method, answered by
  `SqliteSettlementReadModels.countedOf`: the settlements paid or being refunded, whose `countedFrom` is the first history line that is
  `paid` or `refunding`, or the recording of a settlement that has no such line (a settlement stored before its history was kept).
  Nothing of a settlement is copied into Ledger, as before, and `settledOf` (the balances) is unchanged.
- **One statement, two queries that read it.** `readMemberStatement` (Ledger, `Application/Queries/GetMemberStatement`) is the statement:
  the guard of request 8 (a member of the group reads any member, a former member is still read), the expenses the member paid or is in the
  split of, the counted settlements the member pays or receives, and the running balance. `GetMemberStatementQueryHandler` (request 8) and
  `GetMemberStatementCsvQueryHandler` (the storm's query, Ledger's `Application/Queries/GetMemberStatementCsv`) both call it, and differ only
  in their names, which the inventory of the storm names.
- **The order.** The date is the day a line is listed under: an expense's day, or a settlement's day in UTC from `countedFrom`. On the same date
  the earlier moment first: an expense by its `expense-recorded` audit entry, a settlement by `countedFrom`. An expense with no such entry
  (recorded before the audit of ADR 19) has no moment, so it is listed first on its day, in the order it was recorded. On a tie, an expense
  comes before a settlement. A settlement's `paid` is its amount for its payer and 0 for its payee; `share` is the reverse; `description` is
  `Settlement in cash` or `Settlement through the provider`.
- **The statement's balance.** It is the last entry's running balance, which now includes the counted settlements. It equals the member's
  balance in the group, except for a balance that passed to the owner when the member left (request 20): a passage is not an entry of the
  statement, as ADR 11 decided, so the statement keeps the balance the member had from their entries alone.
- **The CSV is rendered by the transport.** `FastifyStatementController.getStatementCsv` answers the query's statement with `renderStatementCsv`
  (`Presentation/API/REST/Controllers/StatementCsv.ts`), in the header's column order, lines ending in CRLF, and a field quoted only where it
  holds a comma, a double quote or a line break, each double quote doubled. Its content type is `text/csv; charset=utf-8`. A refusal is the
  statement's JSON one, with the same statuses (401 without a caller, 404 for a group or a member that does not exist for the caller).

## Consequences

- The statement of a member is one query on the expenses and the audit, one on Settlements' table, and no write. A balance read is unchanged.
- The statement's balance and the group's balance agree for every member that has not left with a balance, because the statement and the
  balances count the same settlements from the same read model.
- A settlement refunded after it was paid leaves the statement at the refund, as it leaves the balances, and its line is gone. Listing a
  refund as a line of its own is a new fact and a new decision, which request 29 does not give.
- A file made before the audit of ADR 19 lists its expenses on each day before that day's settlements. Such files are recreated, as the
  application keeps no migrations (ADR 8); the fallback keeps a read of one from failing.
- `GetMemberStatementCsvQueryHandler` is a second query over the same statement, so the storm's inventory and the routes match. The hot spot
  reads that the CSV is not another query; the code keeps the inventory's name for it and no second rule.

## When to revisit

- If a refund must show in the statement, the refund is a line of its own with its own date and sign, decided in a new ADR.
- If `countedOf` is read for many members at once, it may be answered for the whole group once, as ADR 7 already notes for `settledOf`.
