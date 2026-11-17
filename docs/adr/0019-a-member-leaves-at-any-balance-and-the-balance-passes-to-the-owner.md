# 19. A member leaves at any balance, and what it owes or is owed passes to the group's owner

## Context

Request 20: members who moved out could not leave until someone chased them for the last few euros. Now a member may leave whatever its
balance, and the owner of the group takes over what is left: with 600 for Ann (the owner), −300 for Bob and −300 for Cy, when Bob leaves,
Ann is at 300 and Cy at −300. The owner still cannot leave. A member does not leave while a payment of theirs waits at the provider
(pending or refunding, requests 13 and 15). An expense or a settlement sent at the same moment as a leave is either counted in what passes
or refused, and the balances of the group add up to 0 at every moment. Someone who left and joins again is a member from that moment, with
a balance of 0. The storm (`conventions/storms/leave-with-a-balance.yaml`) decided that the Group records what passes, that Ledger counts it
when it reads the balances, and that the wait for a provider payment is a port Groups owns and Settlements answers. It also brings the
relationship Settlements → Groups, which the context map did not declare.

This supersedes the rule of docs/adr/0009 that a member leaves only at a balance of 0. The rest of that decision holds: a former member keeps
its place in the record, and the cross-context read models are opened at the composition root.

## Decision

- **The leave is decided at any balance.** `Group.leave()` takes the member's balance and whether a payment of theirs waits (`waitingPayment`),
  asked in the leave's own transaction. The owner is refused (`OwnerCannotLeave`), and so is a leave while a payment waits
  (`PaymentWaiting`, a 422). Otherwise the member leaves, and the group records `BalancePassed` (from the member, to the owner, the balance)
  beside `MemberLeft`, in one step. `BalancePassed` has no subscriber and no integration event: Ledger reads what passed when it reads
  the balances, as it reads who is a member.
- **What passed is kept on the membership.** Each membership has `passed`, the sum of the balances its leaves passed, cumulative. A member
  who joins again keeps it, so its balance starts at 0: Ledger counts it from what it had when it left (`balance − passed`). Before this
  request nothing had passed, so the column defaults to 0 and no existing row changes.
- **Ledger carries it when it reads the balances.** `IGroupMembers.passedBalancesOf` gives the owner and each member whose leaves passed
  something or who left (`current` tells whether it is a member now). `SqliteExpenseQueries.balancesOf` takes each such member's
  `passed` off its balance and gives the owner their sum; a former member who has not joined again is left off the list, and what it still
  holds passes to the owner too. The balances listed add up to 0 whatever a later edit or deletion does to a former member's expenses.
- **A pending payment is Settlements' answer, through Groups' own port.** `IWaitingPayments` (Groups' Domain) is answered by
  `WaitingPaymentsOfSettlements` in Groups' Infrastructure, over Settlements' read model: `providerWaitingOf(groupId, memberId)`, a
  provider settlement the member pays or receives that is `pending` or `refunding`.
- **The race is serialised on the one database.** A leave and an expense or a settlement each run in a write transaction (`BEGIN IMMEDIATE`).
  Whichever commits first decides: an expense or a payment that commits first is in what passes, and a later one reads a former member and
  is refused. A new integration event or a second write path is not needed.
- **No route changes.** `POST /v1/groups/{id}/leave` answers as before; the refusal for a waiting payment is a 422 `PaymentWaiting`.

## Consequences

- Balances now include members who left owing or owed. A member's balance can be non-zero as it leaves: the owner's balance moves by it at
  that moment, and the owner's balance can change because someone else left.
- The owner absorbs every former member's balance, not only the first one who left: an owner who is owed a lot may receive debts it did
  not expect. That is what request 20 asks, and the storm's decision.
- Each balance read now reads Groups' membership in one more statement, on the read model's own connection, once per read.
- A payment of the member that waits at the provider blocks its leave until the webhook settles it. A payment the provider never answers keeps
  its member in the group.

## When to revisit

When the owner's balance needs to show what passed and from whom (then the `BalancePassed` events become a record Ledger keeps, not a
recomputed sum); and when a member's leave must be refused for a balance over a limit (a product rule that would supersede this one).
