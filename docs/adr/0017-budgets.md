# 17. Budgets: a monthly limit per category in Ledger, and a month that passes it is told once

## Context

Request 24: an expense has a category (one of eight, `other` when none is given; a recurring expense gives one to its expenses).
The group's owner sets a monthly budget for a category, in the group's currency, and removes it. When an expense is recorded or
edited and its month then spends more than its category's budget, every member of the group is told, once for that month: a
month that goes further over, or comes back under and over again, makes no other notice. The storm
(`conventions/storms/budgets.yaml`) decided the hot spots before the run.

## Decision

- **No new context and no new relationship.** The budget is an aggregate in Ledger (`Domain/Budget`), beside the expenses it
  limits. Ledger already asks Groups who is a member and what role each has (GroupMembers, ADR 3); the owner is read through that
  port. Notifications is told through the integration event Ledger already publishes to it (ExpenseRecorded's relationship, T9):
  the link carries one more contract, `BudgetPassed`, declared in the published language. The conventions' context map is not
  given a new relationship; its text names the added contract.
- **The category is a value of the expense.** `Category` is the list, in the order budgets are read; an expense (and a recurring
  expense) keeps one, `other` when none is given. An allowed value is the domain's to decide (InvalidCategory), so the transport
  only checks its shape. Stored in side tables, as the splits were, because the migrations run `CREATE … IF NOT EXISTS` at every
  start and cannot add a column; the rows of expenses recorded before it are `other`, given once.
- **A budget keeps the months it was passed in.** `Budget` holds its amount, whether it limits its category (`active`), and the
  months it was passed in. Removing it makes it inactive and keeps those months, so that a month is told once whatever is set or
  removed after it. Setting it again makes it active at the new amount; setting or changing it passes no month by itself.
  The owner's rule is the aggregate's (`establish`, `amend`, `lift` refuse another member, NotAllowedToChangeBudget).
- **A month is judged by the policy on the expense's fact.** `ExpenseMonthBudgetEventHandler` runs on ExpenseRecorded and on
  ExpenseEdited, in its own transaction: it reads what the expense's month spends in its category (a sum over the live expenses,
  read in the transaction), the budget of the category, and asks the budget to `judge` the month. The budget records BudgetPassed
  once, and the members to tell are read through Groups at that moment (every member, the payer included).
- **The fact reaches Notifications once, through the outbox.** The budget and its passed month are saved with the same transaction
  as BudgetPassed (domain event, recorded on the aggregate and published after the commit, EVENT-AFTER-COMMIT). BudgetPassedEventHandler
  publishes BudgetPassed as the integration event; Notifications' reaction makes one budget notice per member, in its own
  transaction. The reaction is not made idempotent by hand: the month is recorded as passed by the budget, and the bus delivers
  the fact once, as the storm decided.
- **Names of the aggregate's operations do not collide with others.** The checker of the storm reads a handler's calls by name
  (`.name(`), so the budget's operations are not named `create`, `set` or `remove`, which every event and aggregate call uses:
  `establish`, `amend`, `lift`, `judge`.

## Consequences

- A notice of a budget names its category, month and budget, and carries the spending the notice was made on as its `amount`.
  Its table gains the three columns; a file made before them is rebuilt once, keeping every row (`migrateNotices`).
- Two expenses recorded at the same time in one category are judged one after the other, by the transactions of their
  reactions; the optimistic version of the budget refuses the second save if it read before the first, and that reaction then
  fails and is logged. Its month is judged again at the next expense of that category and month.
- Editing an expense into another month judges only the month it is now in; the month it left is not told anything new (it can
  only spend less).

## When to revisit

When a budget must be told for a month that has ended without any expense of its category (a sweep, as for reminders, ADR 12), or
when the reactions need a retry on conflict as the commands do (CONC-OPTIMISTIC).
