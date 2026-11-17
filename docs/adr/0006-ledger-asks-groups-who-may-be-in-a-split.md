# 6. Ledger asks Groups who may be in a split, and the expense is an aggregate

## Context

Request 4 of Tally (an expense, split equally between members of its group, the payer among them) was stormed before the code
(`conventions/storms/record-an-expense.yaml`, decided with the product's owner). The storm says three things that the
architecture had not yet carried. Ledger must know who may be in a split, and that answer is Groups' (ADR 1, T3). The
relationship Groups → Ledger was declared `planned` in `conventions/domain.yaml` until the code carried it. And an `Expense`
is an aggregate whose `RecordExpense` records `ExpenseRecorded`, which the storm names and no code yet reacts to.

## Decision

- **The relationship Groups → Ledger is carried now.** It is over an owned port, as ADR 1 decided: Ledger owns
  `IGroupMembers` (`Application/IGroupMembers.ts`), in its own words, answering the group's current members in the order they
  joined, or nothing when there is no such group. The relationship is no longer `planned` in the context map. Ledger → Groups
  (`MemberBalances`, T5) stays `planned` until request 20.
- **Groups answers through a read-model port of its own.** `IGroupRoster` (`Groups/Domain/Group/Ports/IGroupRoster.ts`) is what
  Groups gives other contexts: `membersOf(groupId)`, in join order, the owner first. Groups' store implements it, and Groups'
  wiring exports it as `roster`. Nothing of Groups' application is shared.
- **Ledger's infrastructure builds its port over the roster.** `GroupMembersFromGroups` (`Ledger/Infrastructure/`) implements
  `IGroupMembers` over `IGroupRoster`, the only file of Ledger that imports Groups, through its Domain as the layers allow. The
  composition root hands the roster to Ledger's wiring, so Ledger's wiring imports no other context. A member who has just
  joined can be in a split at once, since the roster is read when Ledger decides.
- **`Expense` is an aggregate root, and `ExpenseRecorded` a domain event.** `Expense.register()` validates the description
  (1 to 100 characters, not only spaces), the amount (a whole number from 1 to 100 000 000), the date (a real day of the
  calendar, not after today in UTC), and the split: every member is one of the group's, each is listed once, and the payer
  is among them. It generates the identity (DOMAIN-IDENTITY) and records `ExpenseRecorded`. Its shares are a `Split` value,
  equal, each rounded down, the remainder whole to the payer, kept with the expense and never computed again at a read.
- **The trigger is the storm's.** The Lite profile takes an aggregate and a domain event where a trigger fires (ADR 40). Here
  neither trigger fires in the code yet: one command writes an expense, and nothing reacts to `ExpenseRecorded`. The storm
  decided both before the code, as ADR 5 did for `Group`, because the balances (feature 5, T4) will be a read model written
  from these facts, and the shares' sum is an invariant of one expense. The trigger is recorded here, not taken silently.
- **A non-member is answered `404`** for the group, and for an expense of a group they are not in: the same answer as for one
  that does not exist (as ADR 5 for groups).

## Consequences

- `conventions/domain.yaml` loses the `planned` flag on Groups → Ledger; the conventions check refuses a relationship the code
  does not carry, and now the code carries it.
- Ledger's tables name the group's id with a foreign key to Groups' `groups` table, which the composition root creates first.
- No integration event is published: the storm lists no policy, and no other context reacts to an expense yet.

## When to revisit

When request 5 (balances) reacts to `ExpenseRecorded`, which takes its trigger, and when request 20 declares Ledger → Groups
and `MemberBalances`. When the roster must also say who left a group, the port grows a method and the adapter follows.
