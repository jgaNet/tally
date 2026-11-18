# 15. Ledger decides a passed budget once a month, and Notifications tells each member from BudgetPassed (no new link: the Ledger → Notifications link, carried)

## Context

Request 24 has the owner of a group set a monthly budget per category (groceries, rent, …) in the group's currency, and tells every member
once a month when an expense recorded or edited makes its month spend more than its category's budget. The storm `budgets` decided the
hot spots with the product's owner: a `Budget` aggregate in Ledger, the policy on an expense's recording and edit that asks it to decide,
the fact published to Notifications through the outbox, and the members to tell read when the decision is made. This ADR records what the
storm left to the code.

## Decision

- **A budget is an aggregate of Ledger** (`Budget`), one per group and category, beside `Expense` and `RecurringExpense`. It keeps its
  amount (NULL once removed) and the months it has passed, as a set. Only the group's owner sets or removes it (`set`, `remove`), and an
  amount is from 1 to 100 000 000. Setting a budget records BudgetSet and makes no notice.
- **The decision is the budget's.** `Budget.decide` takes the month, what it spends, and the members to tell. It records BudgetPassed and
  keeps the month only when the budget is set, the spending is more than it, and the month has not passed before; otherwise it answers nothing
  to save. A month that goes further over, or comes back under and over again, is told once.
- **The policy reads what the month spends and asks the budget.** `ExpenseBudgetPolicy` runs on ExpenseRecorded and ExpenseEdited, in a
  transaction of its own, after the expense is stored: it loads the expense, reads the spending of its category in its month from Ledger's
  own read model (`IBudgetQueries.spentIn`), reads the group's current members through `IGroupMembers.currentMemberIds` (no caller, as the
  recurring job does), and asks the budget. A budget saved first by another writer is decided again from a fresh read, up to three attempts
  (CONC-OPTIMISTIC).
- **The fact goes out with the Budget's change.** `BudgetPassedHandler` restates BudgetPassed as the published `BudgetPassed` integration
  event, through the outbox, after the commit (EVENT-AFTER-COMMIT). Its payload carries the group, the category, the month, the budget, what
  the month spends, and the members to tell.
- **Notifications makes the notices.** `BudgetPassedIntegrationEventHandler` makes one `budget` notice for each member it was given, each in
  its own transaction, at the application's clock. It keeps no record of who was told: the bus delivers the fact once.
- **Removing a budget keeps its months.** A removed budget keeps its row with no amount, so that setting it again in a month it already passed
  does not tell that month a second time.
- **Recorded in the published language.** `BudgetPassed` is declared in `conventions/integration-events.yaml` with its payload, field for field.

## Consequences

- No new context and no new relationship: the Ledger → Notifications link carries `BudgetPassed` beside `ExpenseRecorded`, as the storm says,
  and the Groups → Ledger link carries `currentMemberIds` as before.
- An edited expense is decided in the month and category it has now. A move out of a month or category does not re-decide the old one: a
  passing was already told once, and a month that spends less is not told of.
- The members to tell are the group's members when the policy runs, not when the expense was recorded, as the recurring job does.

## When to revisit

When a budget must be decided with the membership of the expense's month, not the membership at the time (then Groups must keep when each
member joined and left, as it does not today); or when several categories must pass in one fact, in which case BudgetPassed carries a list.
