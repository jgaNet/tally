# 16. Leaving a group passes the member's balance to the owner, and Settlements answers whether a payment waits

## Context

Request 9 let a member leave a group only with a balance of 0, so that the group's balances still add up to 0 (feature 9, ADR 7).
Request 20 lets a member leave whatever their balance: what they owe, or are owed, passes to the group's owner, in the same step
as they leave, so that the balances of the group's members still add up to 0. The API is unchanged: `POST /v1/groups/{id}/leave`
answers as before. A member still cannot leave while a payment of theirs through the provider is `pending` or `refunding`: a payment
that lands after they left would change a former member's balance (requests 13 and 15).

The storm (`conventions/storms/leave-with-a-balance.yaml`) decided the design before the code, and it brings one relationship the
context map did not declare: Groups asks Settlements whether a payment waits (`WaitingPayments`), an owned port in the direction
Settlements → Groups.

## Decision

- **The leave records the amount.** `decideLeaveGroup` refuses the owner and a member with a payment waiting, and otherwise answers
  the balance the member has in the group (read from Ledger through `MemberBalances`, in the same transaction as the leave, ADR 17).
  `Group.leave()` takes the member out and records `MemberLeft` and `BalancePassed` (from the member, to the owner, the amount); the
  repository stores the pass in the groups' table of passes, with the group, at the version it was read at.
- **Ledger counts the pass.** Ledger reads the passes through its own `GroupMembers` port (`passesOf`), and its balances move the amount
  from the member to the owner (`BalancesCountingSettlements`). A member who left has 0 from then on, and a member who leaves and joins
  again starts at 0 and counts only what is recorded from then on, since the pass stays where it moved the balance.
- **The waiting payments are asked of Settlements.** `IWaitingPayments` is Groups' port, answered by `WaitingPaymentsOfSettlements` over
  Settlements' read model (`hasWaitingPayment`: a settlement through the provider, pending or refunding, as payer or payee, in the group).
  The relationship is declared in `conventions/domain.yaml` (Settlements → Groups, owned port), not `planned`: this change carries it.
- **The member's balance cannot move once they have left, so the amount is the balance.** An expense or an edit of one that includes a
  former member is refused (ADR 5, feature 9), and a refund needs both its payer and its payee to be members (request 15). So after a
  member leaves, nothing moves their balance, and the amount recorded is the balance they keep.

## Consequences

- The balances of a group add up to 0 at every read, by construction: a pass moves an amount from one member to another.
- The storage gains one table of passes per group (`expense_group_passes`), additive; a group left before request 20 has no pass, and
  its former members stay at 0, which is what they were.
- Request 9's rule (a balance of 0 to leave) is gone: its tests say the new rule.
- A member's balance that a payment through the provider would change is refused by name (`PaymentWaiting`, `400`), not by a
  conflict; the member leaves once the provider has said the payment succeeded or failed.

## When to revisit

When a member may be paid after they leave (then the pass must follow the payment), or when the owner can leave the group.
