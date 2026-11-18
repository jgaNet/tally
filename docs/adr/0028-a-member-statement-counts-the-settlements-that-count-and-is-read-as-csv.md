# 28. A member's statement lists the settlements that count, in the order of the moments, and is read as CSV

## Context

Request 29: Ann's accountant wants her Tally statement in a spreadsheet, and the money she was paid back on it too. A member's statement
(request 8, docs/adr/0008) listed only the expenses. Now it lists, beside them, the settlements the balances count (requests 12, 13, 15): a cash
one from when it is recorded, one through the provider from when it is paid until it is refunded. The statement's last balance is still the
member's balance in the group (request 5), but for what passed to the owner when someone left (request 20).

The storm (`conventions/storms/statement-as-csv.yaml`) was decided with the product's owner before any code. Its two hot spots are decided and
this record keeps them: (1) Ledger reads the settlements through `SettledAmounts`, the port it owns over Settlements' read model, which answers
each counted settlement with when it started to count; nothing is copied into Ledger. (2) The CSV is the same statement, rendered by the
transport as `text/csv`; the query is the statement's read, and the route is only where the API puts the other rendering.

Building it showed what the storm did not say. A statement is in the order of the day, and on the same day an expense comes by when it was
recorded and a settlement by when the balances started to count it. An expense was ordered only by its rowid (docs/adr/0008), which orders the
expenses among themselves but cannot be compared with a moment.

## Decision

- **Settlements answer the counted ones, one by one.** `ISettlementQueries.countedOf(groupId)` answers each settlement that counts (paid or
  refunding; a pending, failed or refunded one is not listed), with its payer, payee, amount, method and `countedFrom`: the moment its 'paid'
  status was learned, or its recording when the file has no such line. `SettledAmounts` (Ledger's port) gets the same read, in Ledger's words
  (`countedOf`); its adapter translates it. `settledOf`, which the balances read, is unchanged.
- **An expense keeps the instant it was recorded.** `expenses.recorded_at` is written by `SqliteExpenseRepository.save` on the insert, from the
  expense's `expense-recorded` audit entry, which the aggregate writes at the same instant (docs/adr/0027). An edit never changes it. A file
  made before it has `''`, which sorts first on its day. This takes the recorded-at column docs/adr/0008 did not take: a settlement must be
  ordered against an expense by a moment, and the rowid cannot be. The rowid stays the tie-break among expenses.
- **The statement is the expenses and the counted settlements of the member, merged in the domain.** `memberStatementEntries` (Domain,
  pure) orders the lines by the day, then the moment (an expense by `recorded_at`, a settlement by `countedFrom`), an expense before a settlement
  on the same moment, and computes the running balance. A settlement's line: `kind: settlement`, `settlementId`, its day in UTC, `Settlement in
  cash` or `Settlement through the provider`, `paid` for its payer, `share` for its payee. An expense's line is as request 8 says, with `kind:
  expense`. The statement's balance is the last line's.
- **The CSV.** `GetMemberStatementCsv` (Ledger's query) reads the same statement, through the same check of membership, so the group's members
  and a former member alone read it. The route `GET /groups/:id/members/:memberId/statement.csv` renders it with `statementAsCsv`
  (Presentation): the header `date,kind,id,description,paid,share,balance`, one CRLF-ended line per entry, a field holding a comma, a double
  quote or a line break written between double quotes with each double quote doubled. It is answered `Content-Type: text/csv; charset=utf-8`.
  A refusal is answered as every route's: JSON, with its status.

## Consequences

- No context and no relationship is added. The two links the storm names (`SettledAmounts`, `GroupMembers`) already exist in
  `conventions/domain.yaml`, and their contracts are the same ports, with one more method each. `conventions/domain.yaml` is unchanged.
- The statement is read in two steps: the counted settlements first, on their own connection, as the balances read them, then the member's
  expenses in one statement. A settlement paid between the two reads is in the next read, not this one; the balances have the same window.
- The statement's balance is the group's balance of the member, except for what passed to the owner when a member left (request 20): as before.
- The e2e answers of request 8 gain `kind` on each entry (the fragment `api/29-statement-as-csv.yaml` says so); the statement's tests read it.

## Alternatives

- **A reversing line for a refunded settlement.** It would show a settlement the balances no longer count, and make the last balance differ from
  the group's. Not taken: a refunded settlement is not counted, so it has no line.
- **The expenses' order by the audit's instant.** The audit has the instant only from request 28 on, so older expenses would have none. Not taken.
- **Sorting in the application.** The merge is a pure function of two lists already read, so it lives in the domain; the store keeps only the
  reads.

## When to revisit

When a settlement or an expense needs a day or an instant it does not have, or when the statement must read the settlements in the same snapshot
as the expenses (the file's one turn), which needs the two reads on one connection.
