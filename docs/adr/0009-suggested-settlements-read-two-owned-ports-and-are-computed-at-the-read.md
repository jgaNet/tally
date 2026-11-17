# 9. Suggested settlements read two owned ports, and are computed at the read

## Context

Request 11 of Tally (the transfers that would bring every balance of a group to 0, by a stated algorithm, in the order made) was
stormed before the code (`conventions/storms/suggested-settlements.yaml`, decided with the product's owner). The storm decided
that Settlements answers it, that nothing is recorded, and that the algorithm is stated rather than a true minimum. What the
architecture had not yet carried were the two relationships ADR 8 declared `planned`: Settlements needs the balances, which only
Ledger keeps (`GroupBalances`), and the members in the order they joined, which only Groups keeps (`SettlementMembers`).

## Decision

- **Settlements answers the suggestion through `GetSuggestedSettlements`**, a query with a signed-in caller (ADR 8). It reads the
  members of the group in the order they joined, through `ISettlementMembers`, a port Settlements owns, answered over Groups'
  roster (`MembersFromGroups`). A caller who is not a member gets the group's `404`, the same as for a group that does not exist.
- **The balances come from Ledger's read model through `IGroupBalances`**, a port Settlements owns, answered over Ledger's
  `IBalanceRoster`. The roster gains one method, `balancesOf(groupId)`, that answers every member's balance from one snapshot
  read, so the balances the suggestion reads add up to 0 even while an expense is being recorded. Ledger's own store and
  Groups' port are unchanged.
- **The algorithm is a pure function**, `suggestSettlements`, in Settlements' domain: no port, no clock, no state. It takes the
  balances in join order, and at each step the lowest balance pays the highest the smaller of the two amounts. Ties go to the
  member who joined first, because strict comparisons keep the first index. It stops when no balance is owed or none is owed.
- **Nothing is recorded**: the query publishes no fact and writes no row, so the balances stay what the expenses make them.
- **The two links are carried**, so their `planned` flag is removed from `conventions/domain.yaml`. The other three
  relationships that ADR 8 declared `planned` (Settlements → Ledger, Ledger → Notifications, Settlements → Notifications) stay
  `planned`: request 11 does not need them.

## Consequences

- The suggestion is as fresh as the balances, and two readers at the same moment read the same transfers, since the order of
  the members and the balances come from committed data and the algorithm has no hidden input.
- The algorithm is not the minimum number of transfers. It makes at most one fewer than the members whose balance is not 0,
  which is what the product asked for. The true minimum is a hard problem, and a different algorithm would give different
  transfers, so the stated one is the contract.
- The roster's `balancesOf` is a new method of Ledger's read model. Groups' `MemberBalancesFromLedger` keeps using `balanceOf`
  and is not affected.

## When to revisit

When a settlement is made (request 12 and after): a settlement decided against the balances will read them through the same
`GroupBalances` port, and the suggestion's balances may need to count paid settlements (ADR 8's `SettledAmounts`, planned).
