# 6. Settlements carries its two ports, and the suggestion is computed at the read

## Context

Feature 11 (suggested settlements) is the first change that needs Settlements: a member reads the transfers that would
bring every balance of the group to 0. The storm decided three things (`conventions/storms/suggested-settlements.yaml`):
the suggestion is Settlements', not Ledger's, since a suggestion is a settlement not yet made; it is computed at the read
and never recorded; and it follows a stated greedy algorithm, not a minimum number of transfers.

ADR 5 declared the context and the relationships Settlements has, all `planned`, until the code carries them. The
suggestion carries two of them: Ledger → Settlements (`GroupBalances`, the balances) and Groups → Settlements
(`SettlementMembers`, who the members are, in the order they joined). The other three (Settlements → Ledger,
Ledger → Notifications, Settlements → Notifications) stay `planned` until the requests that need them.

## Decision

- **The two relationships are carried now.** `conventions/domain.yaml` no longer declares them `planned`. The mechanism is
  an owned port each, as the storm decided, in the same pattern as ADR 3 and ADR 4: Settlements owns the port and the
  adapter over the other context's read model lives in Settlements' Infrastructure.
  - `IGroupBalances` (`Settlements/Application/Ports`): `balanceOf(groupId, memberId)`, an integer, 0 when nothing is
    recorded. Its adapter, `GroupBalancesFromLedger`, reads Ledger's `memberBalances` export, the read model Ledger already
    publishes for Groups (ADR 4). Nothing of Ledger is added.
  - `ISettlementMembers` (`Settlements/Application/Ports`): `membersOf(groupId)` in join order, and `isMemberOf`. Its
    adapter, `SettlementMembersFromGroups`, reads Groups' `groupMembers` export, the read model Groups already publishes
    for Ledger (ADR 3).
- **The suggestion is a pure function of the balances in join order**, `suggestSettlements` (`Settlements/Domain`): the
  member who owes most (lowest balance) pays the member who is owed most (highest) the smaller of the two amounts; ties go
  to the member who joined first; repeated until every balance is 0. It is in the domain because it is a rule of the
  business, not a read: the same balances give the same transfers for every member who reads them. Balances that do not
  add up to 0 are corrupted state, and throw.
- **A query, not a command.** `GetSuggestedSettlementsQueryHandler` reads the balances and the members and returns the
  transfers. Nothing is saved, no event is published, and no operation is recorded: a suggestion is only a suggestion
  (the storm's decision). A member of the group reads it; anyone else gets 404, as for any group they are not in, and an
  anonymous caller 401.
- **The wiring imports the two read models, not the handlers.** Settlements' wiring imports `memberBalances` from Ledger's
  and `groupMembers` from Groups', and each adapter reads its export when it is asked (the function form of ADR 4), so the
  file's evaluation order does not matter. Settlements is imported by no other context, so no cycle is added.
- **The route is one fragment** (`api/11-suggested-settlements.yaml`): `GET /v1/groups/{id}/settlements/suggested`, answering
  `200 [ { from, to, amount } ]`, the members' account ids, in the order made.

## Consequences

- The context map is true to the code for four relationships: Groups ↔ Ledger (ADR 3, ADR 4), Ledger → Settlements and
  Groups → Settlements (this ADR). Three stay `planned` (ADR 5).
- A balance read here is not the one a transaction decides on: a suggestion is read outside any transaction, as any query
  is. An expense recorded while a member reads the suggestion may change it; that is the nature of a suggestion, and the
  read is consistent as of one moment in each of the two reads it makes.
- The algorithm is the one the request states, so two members reading the same balances see the same transfers, and the
  number of transfers is never more than the members not even, less one. It is not the fewest possible: the fewest is a
  hard problem, and the request does not ask for it.

## When to revisit

When a settlement is recorded (request 12, the book's decisions), the suggestion may need to read what has been settled
(`SettledAmounts`, the planned Settlements → Ledger relationship, ADR 5 T8). When a group's suggestion is asked for by a
member in more than a few dozen members, the one balance read per member may need a single port method.
