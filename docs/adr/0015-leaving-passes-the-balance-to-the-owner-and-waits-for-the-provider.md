# 15. Leaving passes the balance to the owner, and a payment waiting at the provider keeps a member in

## Context

Request 9 let a member leave a group only once their balance was 0, so a member who had moved out could not leave until someone
chased them for the last few euros. Request 20 (`conventions/storms/leave-with-a-balance.yaml`, decided with the product's owner)
changes it: a member leaves whatever their balance, and the owner of the group takes over what is left. The storm brings three
things the architecture did not carry yet: a balance that passes from a leaver to the owner in the same step as the leave; a
relationship Settlements → Groups, so that a member with a payment waiting at the provider cannot leave; and the same-moment race
between a leave and an expense or a settlement that names the leaving member (ADR 7 had left it as a known gap).

## Decision

- **The pass is a fact Groups keeps.** `Group.leave` takes the member's balance as a plain value, as before (ADR 7), and records
  `BalancePassed` (from the leaver, to the owner, the amount, when) beside `MemberLeft`. The aggregate keeps every pass in its
  `passes` list, and the store keeps them in `group_passes`, one row per pass in the order they were made. A pass is never
  undone: a member who joins again keeps what they passed, so their balance is still 0 once they are a member again.
- **Ledger counts the passes when it reads a balance, through its owned port.** `IGroupMembers` gains `passedBalancesOf(groupId)`,
  answered over Groups' roster. Every balance Ledger reads subtracts the leaver's pass and adds it to the owner's, in the same read
  as the expenses and settlements. The leaver's balance is then 0 at the leave, and the balances of the group still add up to 0.
  Ledger's balance read model (`SqliteBalanceRoster`) is built over the same port, so Groups' leave and Settlements' decisions read
  the same balances.
- **A payment waiting at the provider refuses the leave.** Groups owns the port `IWaitingPayments` (`Groups/Application/`), in its
  own words: whether a member has a payment through the provider in a group that is `pending` or `refunding`, as payer or payee.
  Its adapter, `WaitingPaymentsFromSettlements` (`Groups/Infrastructure/`), is over Settlements' read model `IWaitingPaymentRoster`
  (`Settlements/Domain/Settlement/Ports/`), answered by `SqliteWaitingPaymentRoster`. The refusal is `PaymentWaiting` (`422`), a rule.
  The relationship is declared in `conventions/domain.yaml` as Settlements → Groups.
- **The owner still cannot leave** (`403`), and a member who is not one of the group is not there for them (`404`), as before.
- **The same moment is serialised on the one database.** Every use case runs in one write turn (`SqliteDatabase.begin()`, then
  `BEGIN IMMEDIATE`), and its reads, including the membership and the balances, happen inside that turn. A leave and an expense or a
  settlement naming the leaver therefore run one after the other: either the expense or settlement commits first and its amounts are
  in what passes, or it reads a former member and is refused. Nothing needs a lock of its own.
- **The composition root breaks the cycle with read models built over the database alone.** The Groups roster
  (`groupRoster(database)`) is built first; Ledger's balance read model is built over it (through `GroupMembersFromGroups`) and
  Settlements' settled amounts; Groups' wiring is then given Ledger's balances and Settlements' waiting payments. No module imports
  another's module.

## Consequences

- An expense recorded at the same moment as its member's leave is no longer a known gap: it is counted in the pass or refused.
- The refusal `BalanceNotZero` is gone; leaving with a balance is allowed. The earlier leave tests that asserted `422` for it are
  replaced by tests of the pass.
- A former member's expenses still cannot change (ADR 7), so a pass is never changed after it is made.
- Existing databases: `group_passes` is created by `CREATE TABLE IF NOT EXISTS`, and every member who left before this change left at
  0, so no pass is needed for them.

## When to revisit

When the owner may leave a group (a transfer of ownership is then a decision of its own, and the pass goes to the new owner); and when
the provider's payments can be waiting for longer than a request, whether the refusal should wait for them instead of refusing.
