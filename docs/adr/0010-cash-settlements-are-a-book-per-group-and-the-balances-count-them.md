# 10. Cash settlements are decided in a book per group, and the balances count them

## Context

Request 12 of Tally (a member paid in cash by another records it; it never pays more than is owed; two decided at once are decided
one after the other; the balances count it at once) was stormed before the code (`conventions/storms/settle-in-cash.yaml`, decided
with the product's owner). ADR 8 declared the relationship Settlements → Ledger (`SettledAmounts`) `planned`, so that a balance
never misses a settlement that is paid; ADR 9 kept it `planned` because request 11 did not need it. Request 12 is the first to need
it, and it is the one that makes a settlement count.

## Decision

- **The settlements of a group are decided in one `SettlementBook`** (the storm's hot spot 1): an aggregate root per group, whose
  identity is the group's (it is opened, never created: the group's identity is the one it was born with). It is opened with the
  version it was read at, the members in the order they joined (`ISettlementMembers`), and the balances the ledger counts
  (`IGroupBalances`), settlements included. Its behaviour `recordCash` refuses, and nothing is recorded, when the payer is not a
  member or is the payee, the amount is not a whole number of 1 or more, the amount is more than the payer owes, or more than the
  payee is owed. Otherwise it records `SettlementRecordedEvent` with the settlement, whose identity it generates.
- **The store saves the settlement and the book's next version in the command's transaction**, only while the book is still at the
  version it was read at (`settlement_books`, CONC-OPTIMISTIC). Two settlements decided at once: the transaction of each takes the
  database's write turn (`BEGIN IMMEDIATE`), so the second reads the balances the first left, and where a stale version reaches the
  check it is a `ConcurrencyConflictException` that the use case re-reads and decides again (up to three attempts).
- **Ledger counts what was settled** (hot spot 2, T8): a port Ledger owns, `ISettledAmounts`, answered over Settlements' read model
  (`ISettlementRoster`, one statement that moves a payer up and a payee down by the amount). Every balance Ledger reads counts it:
  the group's balances (`GetGroupBalances`), the balance a member leaves with (Groups' `MemberBalances`, over Ledger's
  `IBalanceRoster`), and the balances the suggestions read. A member's statement (request 8) does not: it lists expenses only.
- **The payee records it** (hot spot 3): the caller is the payee, who received the money. A payer cannot claim a payment the payee
  never had.
- **A settlement is not an entry of a statement** (hot spot 4); the statement stays the expenses'.
- **The link Settlements → Ledger is carried**, so its `planned` flag is removed from `conventions/domain.yaml`. The other two
  relationships ADR 8 declared `planned` (Ledger → Notifications, Settlements → Notifications) stay `planned`: request 12 does not need them.

## Consequences

- A settlement's effect on a balance is read, never pushed: the ledger stays the one place balances are read, and a settlement counts
  from the moment its transaction commits.
- Balances still add up to 0: each settlement moves two balances by the same amount in opposite directions, and each expense's rows
  add up to 0, so any sum of committed rows does.
- Expenses do not contend for the book (the storm's decision): an expense and a settlement are serialized by the database's write
  turn, not by the book's version. An edit or deletion that lowers what a payee is owed, decided at the same moment as a settlement, is
  ordered by that turn, so the settlement reads the balance the edit left; the book's version does not guard it.

## When to revisit

When a payment through the provider (request 13 onward) settles a debt that is not yet paid: the book's pending payments and their
webhooks are decided against the same balances, and `SettledAmounts` will need to count only the paid ones.
