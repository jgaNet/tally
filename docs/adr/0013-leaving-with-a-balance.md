# 13. Leaving with a balance: the owner takes it over, and Settlements says whether a payment waits

## Context

Request 9 let a member leave a group only once their balance in it was 0, so a member who moved out had to be chased for
the last euros. Request 20 lets them leave with whatever balance they have: what they owe, or are owed, passes to the
owner of the group, in the same step as they leave, so that the members' balances still add up to 0 at every moment.

The storm (`conventions/storms/leave-with-a-balance.yaml`) decided four things before the run: who decides what passes and
where it is kept; how the expense recorded at the very moment its member leaves is ordered against the leave; that a
payment waiting at the provider stops a leave (through a port Groups owns, WaitingPayments, a relationship it declared);
and that nothing already stored changes, since every member who left before left at 0.

## Decision

- **The Group decides, and records the fact.** `Group.leave` takes the member's balance and whether a payment of theirs
  waits at the provider, both as plain values read by the command in its transaction. It refuses the owner, a non-member,
  and a member with a payment waiting (`PaymentWaitingAtProvider`); otherwise it records `BalancePassed` (from the leaver,
  to the owner, the balance) beside `MemberLeft`. Nothing is refused for a balance any more.
- **BalancePassed is a fact kept by Groups.** It is stored in `group_balances_passed`, append-only, one row per fact at its
  position, and not on the membership: a member who joins again replaces the membership row, and the fact that a balance
  passed must outlive it, or the owner's balance would lose what it was given.
- **Ledger counts what passed when it reads a balance, through GroupMembers.** `IGroupMembers` gains `balancesPassed`,
  answered by Groups' `IGroupMembership.balancesPassed` as the net of each member's passed facts: the owner up by the amount,
  the leaver down by it. Every balance Ledger reads adds it: the query for the screens, the sums a settlement is decided
  on, and the balance a leave reads. A statement still counts the expenses only, as it counted the settlements (request 8).
- **A payment waiting at the provider is Settlements' answer, asked through a port Groups owns.** `IWaitingPayments`
  (Groups' Domain) is answered by `SettlementsWaitingPayments` (Groups' Infrastructure) over `IMemberPaymentsWaiting`
  (Settlements' Domain), which counts the provider payments a member pays or receives that are `pending` or `refunding`.
  Settlements' wiring exports it for a command (`memberPaymentsWaitingInCommand`), reading the connection the leave's
  transaction holds. The composition root gives it to Groups' module, as it gives the balance port: the two wirings do not
  import each other.
- **The order against an expense or a settlement at the same moment is the database's.** Every command's transaction begins
  `IMMEDIATE` (ADR 2), so the leave reads the balance and the waiting payments, and writes, before or after another command
  does. If the expense or the settlement commits first, its share is in what passes, or it is in the waiting payments; if
  the leave commits first, the other reads a former member and is refused (`NotAGroupMember`, `NotAMember`). Either way the
  balances add up to 0. This is the storm's decision, kept as it was decided.
- **Nothing stored changes.** A member who left before this request left at 0, so no fact is written for them; the new table
  starts empty.

## Consequences

- `Ledger → Groups` no longer requires a balance of 0 (its `why` says what Groups asks now). `Settlements → Groups` is a new
  relationship, `owned-port`, declared in `conventions/domain.yaml` before its code.
- The `BalanceNotZero` refusal is gone: its route answers the same 202 and an operation that succeeds.
- A statement of a member who left with a balance shows the expenses' balance, not the passed one (the balance field is
  the expenses' sum, as it always was); the balances read by the members of the group are the ones that add up to 0.
- The composition root builds Groups' module from two ports (`groupsModuleWith(memberBalances, waitingPayments)`).

## When to revisit

If the statement should show what passed (or the settlements it already leaves out), it is a read-model change in Ledger, and
the API's statement entries would need a line for a transfer that is not an expense. If a leave and an expense must be
ordered by a single transaction across contexts, the alternative is a saga, which this request does not need, since the
database orders the two writes.
