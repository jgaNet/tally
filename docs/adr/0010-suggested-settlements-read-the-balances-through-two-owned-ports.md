# 10. Suggested settlements read the balances through two ports Settlements owns

## Context

Request 11 lets a member read the transfers that would bring every balance of the group to 0, made by a stated
algorithm, so that every member reading it sees the same ones. The storm decided three things before the code: that
Settlements answers it (a suggestion is a settlement not yet made), that nothing is kept (a query computed at the read,
no fact published), and that the algorithm is the stated greedy one rather than the true minimum, which is a hard
problem that two implementations would answer differently. The storm needs two relationships, both declared `planned`
in the context map since ADR 9: Ledger → Settlements (`GroupBalances`) and Groups → Settlements (`SettlementMembers`).
This is the first feature that carries them.

## Decision

- **Settlements answers the suggestion** with one query, `GetSuggestedSettlements`, at `GET /groups/{id}/settlements/suggested`.
  A member reads it; to anyone else the group does not exist (404), as Ledger's reads do.
- **Two ports Settlements owns**, each in its own words, answered by an adapter over the other context's read model:
  - `IGroupBalances` (`GroupBalances`), answered by `GroupBalancesOfLedger` over Ledger's `IBalanceQueries`, the balances
    of the group in one statement;
  - `ISettlementMembers` (`SettlementMembers`), answered by `SettlementMembersOfGroups` over Groups' `IGroupQueries.membersOf`,
    the members in the order they joined, if the asker is one of them.
  Neither Settlements' Domain nor its Application imports Ledger's or Groups' Domain; the adapters are the only place they are
  read, as Groups and Ledger already do (CTX-CONTRACTS).
- **The algorithm is a pure domain function**, `suggestTransfers`, of the members in join order and their balances: the
  member who owes the most pays the member who is owed the most the smaller of the two amounts; ties go to the member who
  joined first; repeat until every balance is 0. It makes at most one fewer transfer than the members whose balance is not 0.
  The balances must add up to 0; a group whose do not is corrupted and throws, as a programming error, not a refusal.
- **Nothing is recorded.** The suggestion is computed from the balances as they are at the read; no aggregate, no event,
  no outbox entry.
- **The two relationships are carried**, so their `planned` flags are removed from the context map (`conventions/domain.yaml`),
  as ADR 9 says they are when the code carries them. The other three remain `planned` until their features bring them.

## Consequences

- The suggestion is as fresh as the read: an expense recorded during the read may or may not be counted, as any balance
  read is. Two readers at the same moment see the same transfers, because the algorithm is a function of the balances and
  the join order only.
- The algorithm is not the fewest transfers. A member who wants the minimum for a large group is told the stated one, and
  the request says so.
- Settlements reads Ledger's and Groups' read models through the wirings of those contexts, which is the same pattern
  Groups uses to read Ledger (ADR 7): the modules are read lazily, at the request.

## When to revisit

At request 12 onwards, when a settlement is recorded: the balances a suggestion reads must then count a settlement paid
(`SettledAmounts`, the Settlements → Ledger relationship still `planned`), so that a suggestion made after a payment
does not ask for it again. And if the members' order is ever not the join order, the tie-break of this decision
changes with it.
