# 12. A suggestion of settlements is read from the balances and the members, and recorded nowhere

## Context

Feature 11 (request 11) lets a member read the transfers that would bring every balance of the group to 0, with as few
transfers as the stated algorithm makes: `GET /groups/{id}/settlements/suggested`, answered `200 [{ from, to, amount }]`.
The storm (`conventions/storms/suggested-settlements.yaml`) decided three things before the run: the suggestion belongs to
Settlements, which reads the balances through a port it owns (`GroupBalances`, over Ledger's read model) and the members'
order through `SettlementMembers` (over Groups'); a suggestion is computed at the read and nothing is recorded or published;
and the algorithm is the stated greedy one, not the true minimum.

Building it needed what the storm left to the code: the two links it names were declared `planned` in the context map
(ADR 11, T7), and a query of a new context is a new cross-context read, which the Lite profile says comes in by an ADR.

## Decision

- **The two links are carried, so they are no longer `planned`.** `conventions/domain.yaml` drops `planned: true` from Ledger →
  Settlements (`GroupBalances`) and from Groups → Settlements (`SettlementMembers`). The other three relationships of ADR 11
  stay `planned` until the features that carry them.
- **The ports are Settlements' own, in its words.** `IGroupBalances.balancesOf(groupId)` answers the balances as Settlements
  counts them, a number per member; `ISettlementMembers.membersOf(callerId, groupId)` answers the current members in the order
  they joined, `undefined` to a caller who is not one (as if the group did not exist). Their adapters live in Settlements'
  Infrastructure: `GroupBalancesOfLedger` over Ledger's `IExpenseQueries`, `SettlementMembersOfGroups` over Groups'
  `IGroupQueries`, each translating to Settlements' words, as Ledger and Groups do (docs/adr/0004, docs/adr/0009).
- **The read models come from the composition root.** Settlements' wiring takes `ledgerReadModel` and `groupsReadModel` from
  `src/Bootstrap/Fastify/readModels.ts`, as ADR 0009 placed them, so no two wiring files import each other.
- **The suggestion is a pure function of the balances in join order.** `suggestTransfers` (Settlements' Domain) takes the
  members with their balances, in the order they joined, and repeats: the lowest balance below 0 pays the highest above 0 the
  smaller of the two amounts, on a tie the first to join is taken. It reads nothing and records nothing; the query answers its
  result, and no event is published. Balances that do not add up to 0 stop it when one side is empty, rather than loop.
- **A query, answered at once.** `GetSuggestedSettlements` reads the balances, then the caller's membership and the members
  (the order of ADR 0005: a member who has left had a balance of 0, so the members read after include every counted balance).
  A caller who is not a current member gets `404`, as for every group read; a missing caller gets `401` at the transport.

## Consequences

- Every member reading the group sees the same transfers, since the algorithm and the order are stated and the balances are
  read the same way for everyone. Reading changes no balance: a second read after the first is the same.
- The suggestion is not a commitment: a settlement made later (request 12 onward) is decided against what is owed then, and the
  suggestion of this request is read again at that time.
- The known gap of ADR 0009 stays as it was: an expense recorded between the balances' read and the members' read of a suggestion
  can make the suggestion count a balance the members list does not show. It is a read, so the next read is correct.

## Alternatives

- **Store the suggestion, and recompute it on each change.** The storm said no: a suggestion is a settlement not yet made, and a
  stored one would have to be kept in step with every expense. Not taken.
- **Ask Ledger for the members too.** Ledger's `balancesOf` lists only the members with a balance; the members' order belongs to
  Groups (ADR 1), so Settlements asks Groups for it, in its own port. Not taken.
- **The true minimum number of transfers.** The problem is hard, and two implementations could answer different transfers for the
  same balances, which members would read as disagreement. The stated algorithm is the one the product's owner decided. Not taken.

## When to revisit

When a settlement is decided (request 12 onward), the suggestion is read against the book's settled amounts, and this ADR's
balances are the ones Ledger reads with the settlements counted (ADR 11, T8). When the algorithm changes, a new ADR replaces the
ordering and the ties, and the transfers already shown are not computed again.
