# 6. Suggested settlements: Settlements carries the two links ADR 5 planned

## Context

ADR 5 declared Settlements and five relationships before the code that carries them, all `planned` in the context map
(`conventions/domain.yaml`). Request 11, suggested settlements, is the first feature that needs two of them: a member
reads the transfers that would bring every balance of a group to 0, from the balances Ledger keeps and the members
Groups lists in their join order. The feature needed no new context and no new relationship, so the architecture task
is to carry what was already decided, and to say how.

## Decision

- **Settlements answers the suggestion** (the storm's first hot spot, decided before the run): a query, computed at the
  read, that asks two ports Settlements owns, in its own words: `GroupBalances` (`balancesOf`) and `SettlementMembers`
  (`currentMembers`).
- **Ledger → Settlements (`GroupBalances`) is carried over a read port Ledger exports.** Ledger owns the answer's shape
  in its Domain: `IGroupBalanceSums`, the balances of a group as its balance entries have them, read outside any
  transaction. Ledger's wiring exports an instance of it (`groupBalanceSums`), as Groups exports `groupMembership`
  (ADR 3). Settlements' adapter, `LedgerGroupBalances`, implements Settlements' `GroupBalances` over it and never
  reaches into Ledger's application or infrastructure.
- **Groups → Settlements (`SettlementMembers`) is carried over Groups' read port** `IGroupMembership`, which Groups'
  wiring already exports for other contexts (ADR 3). Settlements' adapter, `GroupsSettlementMembers`, implements
  `SettlementMembers` over `listMemberIds`, which answers the members in the order they joined.
- **The algorithm is a pure rule in Settlements' Domain**, `suggestSettlements`: the most owing pays the most owed, ties
  to whoever joined first, until every balance is 0. It holds no port and records nothing, so no domain event exists
  for it and no fact is published.
- **The two relationships are no longer `planned`** in the context map, since the code now carries them. The other
  three stay `planned` until the features that need them come.

## Consequences

- A suggestion reads Ledger's balances in one statement and Groups' members in a second read. The order is the same as
  Ledger's balance query: the balances first, then the members, so that a member who left (at 0) is never missing from
  a sum that is not 0. The balances of a group still add up to 0 in the suggestion; if they do not, the rule throws
  (the ledger is corrupted) rather than suggesting a transfer that does not clear.
- Settlements has no aggregate yet. The later settlement book (ADR 5) will sit beside this query without changing the
  two ports' owners.
- The suggestion is the greedy algorithm the product states, not the fewest possible transfers: the minimum is a hard
  problem, and the stated order is what every member reads.

## When to revisit

When Settlements decides a settlement (the book, at checkpoint 2's next requests), since that is where `GroupBalances`
must read inside a transaction, as Ledger's `memberBalanceSumsInCommand` does for Groups (ADR 4); and when a
settlement's effect on a balance is read by Ledger (`SettledAmounts`, ADR 5, planned).
