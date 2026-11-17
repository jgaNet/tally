# 11. A member leaves whatever their balance, and the balance passes to the owner in the same step

## Context

Request 20 lets a member leave a group whatever their balance, which passes to the group's owner. Until now a member could leave
only with a balance of 0 (request 9, ADR 4), so a member who had moved out had to be chased for the last euros. The storm for the
feature (`conventions/storms/leave-with-a-balance.yaml`) decided what passes and where it is kept (the Group, in the leave's own
transaction, recorded as a `BalancePassed` fact beside `MemberLeft`), how Ledger counts it (when it reads the balances, through the
port it already owns for who is a member), how a payment waiting at the provider keeps a member in the group, and how an expense or
a settlement sent at the very moment someone leaves is either counted in what passes or refused.

The storm declared one relationship the context map did not: Groups asks Settlements whether a payment the member pays or receives
is waiting at the provider. The map (`conventions/domain.yaml`) had no link from Settlements to Groups, so the check refused it.

## Decision

- **Groups records the passage.** `Group.leave` takes the member's balance (read by the handler from Ledger, as before) and whether
  a payment of theirs is waiting at the provider. It refuses a waiting payment (`PaymentWaitingAtProvider`), and otherwise records
  `BalancePassed` (the leaver, the owner, the amount) beside `MemberLeft`, in the same transaction. A passage is kept in its own table
  (`balance_passages`), in the order it passed, and is never changed. A former member who joins again keeps its passages, so its
  balance is 0 from the moment it joins again.
- **Ledger counts a passage when it reads a balance.** Its `GroupMembers` port gains `passedBalancesOf`, answered over Groups' read
  model. A balance reads each passage: the leaver's balance goes down by the amount it passed, the owner's goes up by it. The
  balances still add up to 0 by construction, and the leaver's is 0 once it has left. Nothing is copied into Ledger's own table, so
  a balance is never half-written.
- **Groups asks Settlements through a port it owns, `WaitingPayments`.** `IWaitingPayments` is owned by Groups, answered by
  `WaitingPaymentsFromSettlements` over Settlements' read model (`isWaitingFor`: a provider payment the member pays or receives,
  pending or refunding). The read model is exported from Settlements' wiring, the way Ledger's is, and the two wiring files import
  each other only through functions read when the answer is asked (ADR 4). The context map declares the link Settlements → Groups,
  `owned-port`, with its reason, and it is not `planned`: the code carries it.
- **The race is decided by the database, not by a lock of ours.** The leave, an expense and a settlement each run in a transaction
  that takes the file's write lock at once (`BEGIN IMMEDIATE`, ADR 2). So either the expense or settlement commits first, and the leave
  reads the balance that includes it, or the leave commits first, and the expense or settlement reads a former member and is refused.
  Either way the balances of the group's members add up to 0.
- **A former member's balance does not move afterwards.** Request 9 already refuses to edit or delete an expense that concerns a
  member who has left, and a refund needs both members to be current, so nothing changes what a former member owes once they left:
  the passage is the whole of their balance, and the owner's total stays right.

## Consequences

- A member with a payment waiting at the provider still cannot leave; they can leave once the payment has ended.
- A file made before this change has no `balance_passages` rows. Each former member of such a file left with 0 (request 9 required
  it), so nothing passes for them, and the table is simply empty for them. The table is created on start, as the other tables are.
- The owner's balance can move by any amount when a member with a debt leaves. That is the rule, not a side effect, and it is visible
  in the balances and in the owner's share of what is left.
- The member's statement is still expenses only, as request 8 says; it does not show the passage. Its entries keep the expenses as
  they were recorded.

## When to revisit

If the owner should be asked before a debt passes to them (a refusal, not a transfer), or if a passage should be shown in the
statement, a new fact and a new decision are needed; neither is in request 20. If a refund ever needs to reach a former member, the
refund must pass its effect to the owner the same way, and that is a new ADR.
