# 7. Ledger counts what is settled, and Settlements decides on the balances

## Context

Feature 12 (settle in cash) is the first change that writes to Settlements. A member who has been paid in cash by another
member records it: the payer's balance goes up by the amount, the payee's down, and the balances still add up to 0. It is
refused when it would pay more than the payer owes or more than the payee is owed, at the moment it is recorded, and two
recorded at once are decided one after the other. The storm (`conventions/storms/settle-in-cash.yaml`) decided that
Settlements keeps a `SettlementBook` per group, that Ledger counts what is settled through a port it owns, and that a
settlement is not an entry of a member's statement.

ADR 5 declared the relationship Settlements → Ledger (`SettledAmounts`) as `planned`, until the request that needs it. The
settlement needs it: a balance Ledger reads must count the settlements paid, and the book's rule reads the balances.

## Decision

- **The relationship is carried now.** `conventions/domain.yaml` no longer declares Settlements → Ledger `planned`. The
  mechanism is an owned port, in the same pattern as ADR 3, 4 and 6: the downstream side (Ledger) owns the port, and the
  adapter over the other context's read model lives in Ledger's Infrastructure.
  - `ISettledAmounts` (`Ledger/Application/Ports`): `settledOf(groupId)`, what has been settled in the group, per member: the
    change each settlement makes to the member's balance (`+amount` to the payer, `-amount` to the payee), summed. A member
    with nothing settled is not in the list.
  - Its adapter, `SettledAmountsFromSettlements` (`Ledger/Infrastructure`), reads Settlements' read model
    `ISettledAmountsQueries` (`Settlements/Domain/Settlement/Ports`), exported by Settlements' wiring. As for the other
    ports between the two wiring files, it is a function read when it is asked (ADR 4).
- **Ledger's balances count settlements, with no copy.** `SqliteMemberBalances` adds what is settled to what the expenses
  give, in `balanceOf` and `balancesOf`, when it reads. Nothing of a settlement is written to Ledger's tables, so no copy can
  lag behind. Every reader of a balance counts it: the balances, the suggested settlements (ADR 6), and leaving (ADR 4). A
  member's statement is Ledger's expenses only, as request 8 says, and differs from the group's balance by the settlements.
- **A `SettlementBook` per group is the aggregate a settlement is decided in.** It keeps the group, a version (ADR 8 and
  CONC-OPTIMISTIC: a book that is no longer at the stored version is a `ConcurrencyConflict`, and the command re-reads and
  re-decides, up to three attempts), and the settlements recorded in it. It decides against the two balances the handler
  reads through `IGroupBalances` inside its transaction. Only settlements contend for the book; an expense does not bump it.
- **The payee records it.** The caller is the payee; the payer is named in the body and must be a member of the group, not
  the payee. For anyone who is not a member the group does not exist (404 in the operation's refusal).

## Consequences

- A settlement is counted into every balance the moment its transaction commits, and a balance read inside a transaction
  sees the settlements committed before it. Two settlements at once are serialised by the file's write lock, and the book's
  version check is the rule's own guard should a write ever be decided on a read it did not hold.
- Ledger now reads Settlements' table through its port, so the ledger's balance read costs one more query per member read.
  At the group sizes the requests describe, that is not a concern; the read model is one table scanned by group.
- A balance read outside any transaction (a query such as the suggestions) reads the expenses and the settlements in two
  statements; a settlement committed between them can show in one and not the other. This is the same property a
  suggestion already has across members (ADR 6), and it is accepted there.

## When to revisit

When a settlement can be pending (the provider's payments, request 20), `settledOf` counts a pending payment as paid, as the
storm decided (T11); if a pending payment may not count, the status moves into the query. When a group's balance reads grow
large enough that a per-member read of settlements matters, `settledOf` may be answered for the whole group once.
