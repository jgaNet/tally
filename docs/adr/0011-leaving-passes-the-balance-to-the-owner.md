# 11. Leaving passes the balance to the owner, and a payment waiting at the provider refuses it (the Settlements → Groups link, carried)

## Context

ADR 5 let a member leave only with a balance of 0 (request 9), so a member who moved out with money owed to or by them
had to be chased for the last euros. Request 20 changes the rule: a member leaves whatever their balance, and what they
owe or are owed passes to the group's owner, in the same step. The storm `leave-with-a-balance` decided the hot spots with
the product's owner: the Group decides what passes, reading the member's balance in the leave's own transaction and
recording it with the leave; Ledger counts what passed when it reads the balances; a payment of the member waiting at the
provider refuses the leave, through a port Groups owns (`WaitingPayments`), a new relationship the storm declared; and an
expense or a settlement sent at the very moment a member leaves is either counted in what passes or refused.

## Decision

- **The leave passes the balance, in one write.** `Group.leave` takes the member's balance as a plain value, read through
  `IMemberBalances` (ADR 5) in the leave's transaction. It records `BalancePassed` (from the leaving member to the owner,
  with the amount) beside `MemberLeft`, and the group keeps the passing. The owner's balance moves by the member's balance
  in the same write that takes the member out, so the balances of the group's members add up to 0 at every moment a
  transaction commits. The owner is the only member who takes a passing over; the owner never leaves.
- **Ledger counts the passings when it reads the balances.** `SqliteBalanceQueries` reads the passings of the group through
  Ledger's own port `IGroupMembers.passingsOf` (answered over Groups' read model): each passing lowers the member it is
  from and raises the member it is to by its amount. A member who left therefore has a balance of 0 from the moment they
  left, their expenses are not changed, and the owner's balance counts what passed to them. The same read serves the
  leave's balance, the group's balances, the suggested settlements and the reminders, so they all agree.
- **A member who joins again has a balance of 0.** Their expenses still count what they counted, and the passing they made
  when they left is still kept, so the two cancel: the balance a rejoined member has is what their expenses have counted
  since they joined. The passings are never removed.
- **A payment waiting at the provider refuses the leave.** Groups owns the port `IWaitingPayments`, and its adapter
  `SettlementsWaitingPayments` (Groups' Infrastructure) answers it over Settlements' read-model port
  `ISettlementQueries.openProviderPaymentsIn`: a settlement through the provider that is `pending` or `refunding`, read
  whether the member pays it or receives it. The leave is refused with `PaymentWaiting` (409) and the member stays in the
  group; they leave once the payment has ended. The read is a plain value the aggregate decides on (`leave`'s
  `paymentWaiting`).
- **The two decisions are serialised on the one file.** Within one process, each command's transaction holds the file's turn
  from its begin to its commit (ADR 4). Across processes, each unit of work begins with `BEGIN IMMEDIATE`, which takes SQLite's
  write lock at once, with a busy timeout, so the same holds for two servers on one database. So a leave and an expense or a
  settlement sent at the same moment run one after the other. Either the expense or the settlement commits first, and its share
  or its payment is in the balance the leave reads and passes; or the leave commits first, and the expense or the settlement
  reads a former member and is refused, as today. No moment is left where the balances do not add up to 0. The gap of ADR 5 is
  closed by this.
- **Nothing is stored differently for the members who left before.** Each of them left at a balance of 0, so no passing was
  recorded for them and nothing changes for them; the new table is created when the repository is, and holds no row for them.
- **The statement is unchanged.** A former member's statement lists their expenses as it always has (request 8: the statement
  counts expenses only, not the settlements, and the passing is not an expense). Its balance is the expenses' balance, as it
  was; the passing is shown by the balances, not by the statement.

## Consequences

- The context map carries the new relationship Settlements → Groups; `yarn check:conventions` holds the code to it
  (CTX-MAP-DECLARED). The Ledger → Groups link is carried by the passings too, through `GroupMembers`.
- The composition root (`src/Bootstrap/Fastify/readModels.ts`) builds the reads the two new adapters need: Ledger's balances
  read now reads Groups' passings, and Groups reads Settlements' open payments. Neither wiring imports the other.
- `BalanceNotZero` is no longer a refusal of leaving; it is removed with the rule it stated.
- A group's passings are kept with the group and are read by every balance read of the group; the table grows by one row for
  each member who leaves with a balance, and the read is proportional to that count. A larger deployment would keep the sums
  in a read model instead, which this decision does not need yet.

## When to revisit

When a transaction stops taking SQLite's write lock at its begin, or the application moves off one file: the serialisation of a
leave and an expense would then rest on the order of their reads, not on the lock. Or when a balance is passed to someone other
than the owner (a new decision of the storm, not a change here).
