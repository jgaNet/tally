# 26. A statement lists the settlements the balances count, in the order of their days, and is read as CSV from the same statement

## Context

Request 29 (`api/29-statement-as-csv.yaml`) puts the settlements the balances count into a member's statement, beside the expenses, and lets the
statement be read as CSV (`text/csv`, UTF-8, a header line and one CRLF line for each entry). The storm (`conventions/storms/statement-as-csv.yaml`) was
decided before the code. Its hot spots: Ledger learns of the settlements through `SettledAmounts`, the port it owns over Settlements' read model, which
now answers each counted settlement of a member with when it started to count, and nothing is copied into Ledger; and the CSV is the same statement,
rendered by the transport as `text/csv`, the query being the statement's own.

A statement orders its entries by day, then by instant on the same day: an expense by when it was recorded, a settlement by when the balances started to
count it. Until now an expense had only a sequence number (`recorded_seq`, request 8), which orders expenses among themselves and cannot be compared with
an instant. A settlement's instant is the moment it became `paid` (its line of the history, ADR 11, request 19): for a settlement in cash that is when it
was recorded, for one through the provider when the provider said it succeeded.

## Decision

- **No new context and no new relationship.** Ledger's `SettledAmounts` (Settlements → Ledger, ADR 11) gains one answer, `countedOf(groupId, memberId)`: each
  settlement the group counts in which the member is a party, with its id, its payer and payee, its amount, its method and `countedAt`, the instant it became
  paid. Settlements' read model (`ISettlementQueries.countedOf`) answers it in one statement, in Settlements' words, and the adapter in Ledger's Infrastructure
  turns it into Ledger's own `CountedSettlement`. Ledger's Domain never imports Settlements; `settledOf`, which the balances read, is unchanged.
- **An expense records the instant it was recorded.** `ledger_expenses` has a `recorded_at` column (ISO 8601 in UTC), written with the insert from the one clock
  the use case is given (`IExpenseRepository.insert(expense, recordedAt)`), and never changed by an edit. A file written before the column has `''`, which sorts
  before every instant: its expenses stay before the settlements of their day, in the order they were recorded (the same order `recorded_seq` gives among
  them).
- **The statement is one read model, merged in one place.** `IStatementQueries.statementOf` (Ledger's Application) answers the entries of a member; its adapter
  `StatementCountingSettlements` (Infrastructure, beside `BalancesCountingSettlements`) reads Ledger's expense lines (`expenseLinesOf`, ordered by date, then
  `recorded_at`, then `recorded_seq`) and the counted settlements, and puts them in the order of a bank statement: the earliest day first, then the instant, and on
  the same instant the expense first. A settlement's day is the UTC day its balance started to count it. Its entry is `kind: 'settlement'` with `settlementId`
  in place of `expenseId`, its description `Settlement in cash` or `Settlement through the provider`, and `paid`/`share` for its payer and payee. The balance is the
  running sum of `paid − share`, the same sign the balances use, so the statement's last balance is the member's balance without what passed to an owner (request 20).
- **The CSV is the same statement.** `GetMemberStatementCsv` (Ledger, `GET /groups/{id}/members/{memberId}/statement.csv`) answers the `StatementView` under the
  same access rule as `GetMemberStatement` (request 8): a member, or any member's statement, a former member's included. The transport renders it with
  `statementAsCsv` (Presentation), and replies `text/csv`; a refusal is answered as the JSON route answers it, through `answerAtOnce`. Two queries share one
  function that reads the statement, so each route is answered by the use case that names it.

## Consequences

- The Ledger file gains a column, migrated in its `#migrate` like the others. Existing expenses keep their order (see above).
- The instant is the clock's millisecond. Two records in the same millisecond are listed in a fixed order, the expense first, which is the order
  ADR 25 gives the audit too; the statement is exact only to the millisecond, as the audit is.
- A refunded settlement is not counted and so not listed (the balances went back), as the balances count. A refunding one is listed, as the money has not gone back.
- No integration event is added to the published language; the port answers more, and the contract's name (`SettledAmounts`) is unchanged.

## When to revisit

When a statement must list what passed to an owner (request 20) as entries, which needs its own kind and the pass's instant (it has one, `expense_group_passes`),
or when the instants must be exact across the two databases (a global sequence would then replace the clock's milliseconds).
