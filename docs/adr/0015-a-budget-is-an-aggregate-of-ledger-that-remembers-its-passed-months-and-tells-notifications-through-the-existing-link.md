# 15. A budget is an aggregate of Ledger that remembers the months it was passed in, and tells Notifications through the link they already have

## Context

Request 24 gives an expense a category (one of eight, `other` when none is given), lets a group's owner set a monthly budget per category,
and tells every member, once for a group, a category and a month, when a recorded or edited expense makes its month spend more than the
budget. The storm (`conventions/storms/budgets.yaml`) decided four hot spots: where a budget is and who decides it is passed, how
Notifications learns of it and who is told, whether it is soon and once across a crash, and whether the category is a value of the expense.

The storm needs no new context and no new relationship. The expenses and their sums are Ledger's; who is the owner, and who the members are,
are read from Groups through `GroupMembers`, the port Ledger already owns (ADR 3); the telling is Notifications', over the integration-event
link Ledger → Notifications that already carries `ExpenseRecorded` (ADR 9). What changes in the architecture is the published language, which
gains one event, `BudgetPassed`, and the context map's reason for that link.

## Decision

- **The category is a value of the expense** (`Category`), one of the eight, `other` when none is given, refused as `InvalidCategory` behind the
  202 when it is any other word. An edit replaces the expense whole, so an edit that gives none makes it `other`. A recurring expense keeps one and
  its day carries it, so the expense that day records has it. Expenses kept before this request are `other` (the column's default).
- **A budget is an aggregate of Ledger, one per group and category.** The owner (the role read through `GroupMembers`) sets it, replaces it by
  setting it again, and unsets it; any other member is refused (`NotTheOwnerOfTheGroup`), and the amount is an expense's (1 to 100 000 000).
  Unsetting keeps the row, marked removed, with the months it was passed in, so that a budget set again for a month already told does not tell
  it again. Setting or changing a budget records no notice.
- **The budget decides it is passed.** A policy on `ExpenseRecorded` and `ExpenseEdited` (`ExpenseBudgetCheckHandler`) reads the expense, what its
  month spends in its category from Ledger's own expenses (the sum of the amounts dated in that month, in UTC; deleted ones are gone from the
  table), and asks the category's budget `pass`. The budget answers itself unchanged unless the budget is set, the month spends more than it and
  the month was not passed before; then it remembers the month and records `BudgetPassed` with the budget, what the month spent and the members
  to tell, as they were when it decided. The policy saves the budget and publishes its fact in its own transaction, with the outbox.
- **A policy on `BudgetPassed` publishes the integration event of the same name**, in the published language (`conventions/integration-events.yaml`,
  version 1): the group, the category, the month, the budget, what the month spent and the members. Notifications makes one `budget` notice per
  member, the payer included, in its own transaction. Nothing is made idempotent by hand: the fact is stored with the budget's change, relayed after
  the commit (EVENT-AFTER-COMMIT), and the bus hands it over once.
- **The notice gains a kind.** A `budget` notice names the category, the month (`YYYY-MM`) and the budget, and its `amount` is what the month spent;
  it names no expense, as a reminder (ADR 10) does not.
- **Reading budgets** lists the group's set budgets in the order of the categories, with what the current month, from the one clock, spends in each.

## Consequences

- A month is told once whatever happens to it afterwards: further over, back under and over again, a budget changed, or removed and set again. The
  budget's version makes two reactions that race over one budget lose and win, never both tell.
- The members told are the ones read when the budget decided, carried in the fact, so a member who joins or leaves between the decision and the
  notice does not change who is told.
- Ledger's expenses are read for the sum by month and category through an index on `(group_id, category)`.
- The policy on `ExpenseRecorded` listed in the storm publishes nothing itself: `ExpenseRecorded`'s own integration event goes out from the
  handler that already did, beside it.

## When to revisit

If a month's spending should be told at a share of the budget (80 %), or in the group's other currencies, the budget's `pass` is where it is
decided, and the notice gains what it needs. If a budget should be per member, it is a new aggregate.
