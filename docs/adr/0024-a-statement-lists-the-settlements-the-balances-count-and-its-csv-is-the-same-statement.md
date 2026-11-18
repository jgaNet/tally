# 24. A member's statement lists the settlements the balances count, and its CSV is the same statement

## Context

Request 29 of Tally (a member's statement lists, beside the expenses, the settlements they paid or received that the balances count; the same
statement is read as CSV in a stated column order) was stormed before the code (`conventions/storms/statement-as-csv.yaml`, decided with the
product's owner). ADR 10 decided the opposite for the statement, "a settlement is not an entry of a statement": it lists expenses only. This
ADR supersedes that part of ADR 10; the rest of it stands, and the balances still count every settlement counted.

The storm asks for no new context and no new relationship. Ledger already reads the settlements through `SettledAmounts` (the owned port over
Settlements' read model, ADR 10), and reads the members through `GroupMembers` (ADR 6). The storm's hot spot 1 decides that the statement reads
them through that port, which answers each counted settlement of a member with when it started to count, and copies nothing into Ledger.

## Decision

- **No new context and no new relationship.** `SettledAmounts` gains one answer, `countedOf(groupId, memberId)`, on the same owned-port link
  Settlements → Ledger. Settlements answers it over its own tables, in one statement: each settlement of the group the member paid or received
  whose status is `paid` or `refunding` (counted by the balances), with its payer, payee, amount, method and `countedFrom`. A `pending` one is not
  counted, nor a `refunded` one (ADR 10, features 13 and 15), so neither is listed.
- **When a settlement started to count** is the `settlement-paid` change Settlements' audit writes in the transaction that counts it (ADR 23):
  at recording for a cash settlement, when the provider says it succeeded for one through the provider. Ledger reads that instant; it does not
  keep its own.
- **Each line of the statement** is an expense (`kind: expense`, its `expenseId`, as request 8) or a settlement (`kind: settlement`, its
  `settlementId`). A settlement's day is the UTC day its balances started to count it; its description is `Settlement in cash` or
  `Settlement through the provider`; the payer's `paid` is its amount and the payee's `share` is its amount, the other side 0.
- **The order** is request 8's, by date first; on the same date an expense by when it was recorded and a settlement by when it started to count.
  Ledger merges the two lists and sorts them in the query (`GetMemberStatement`), the expenses' order coming from the store as before.
- **The balance** of each line is the running sum of `paid` less `share`, counted at the read. The statement's balance is the last line's. It is
  the member's group balance (request 5), except for what passed to the owner when a member left with a balance (request 20), which the statement
  does not count, as request 29 says.
- **The CSV is the same statement, not another query.** `GetMemberStatementCsv` (the storm's name) answers the same read model as
  `GetMemberStatement`, under the same membership rules; the route `statement.csv` renders it in the transport (`statementAsCsv`): the header
  `date,kind,id,description,paid,share,balance`, then one line per entry in the statement's order, UTF-8, each line ended CRLF, a field holding
  a comma, a double quote or a line break written between double quotes with each double quote doubled, and no other field quoted. The response
  is `200` with `Content-Type: text/csv; charset=utf-8`. A refusal answers as the JSON route does (`404` to a caller outside the group, `401` to
  no one signed in), because the route answers through `answerAtOnce()` and renders only a `200`.
- **Nothing is announced.** The statement is read, so no integration event is published, and the published language is unchanged.

## Consequences

- The balances and the statement agree: a settlement counted by the balances is listed, once, on the day it started to count, so a member's
  last line gives the balance the group's balances give them (except for what passed to the owner, request 20).
- A member who reads a statement now sees the settlements that moved their balance, and the CSV they can take into a spreadsheet is the statement
  they see.
- A refunded settlement leaves the statement with the balance it moved: a refund does not show a line of its own in this statement (the audit
  records it, request 28). Showing refunds as lines is a later decision.

## When to revisit

When the statement must show a refund (a line for the money that went back), or a pending settlement, or when a statement is too long to read
whole and needs paging: each is a change to `countedOf` or to the statement's lines, decided here before its code.
