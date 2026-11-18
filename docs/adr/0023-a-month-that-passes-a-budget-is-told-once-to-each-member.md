# 23. A month that passes a category's budget is an aggregate of Ledger, and each member is told once for it

## Context

Request 24: the flat agreed to spend no more than 400 euros a month on groceries, and everyone wants to know when a month goes over. An expense
has a category, one of eight, `other` when none is given; the owner of a group sets a monthly budget for a category, an amount in the group's
currency, and removes it; a member reads the budgets, each with what the current month spends in its category. When an expense is recorded or
edited and its month then spends more than its category's budget, every member of the group is told once for that month, the payer too: a
notice of kind `budget` with the group, the category, the month, the budget and what the month spends. A month that goes further over, or comes
back under and over again, makes no other notice, and setting or changing a budget makes none by itself.

The storm (`conventions/storms/budgets.yaml`) decided before any code: a `Budget` aggregate per group and category in Ledger, which keeps the
months it was passed in; a policy on `ExpenseRecorded` and `ExpenseEdited` that reads the month's spending and asks the budget to decide; Ledger
publishes `BudgetPassed` to Notifications on the relationship the two already have (T9), with the members to tell read when the month passes;
and the fact is stored with the budget's change and relayed after the commit. The storm adds no context and no relationship between contexts.

## Decision

- **A `Budget` is an aggregate of Ledger** (`Domain/Budget`), one per group and category, identified by a generated id and found by the pair. Its
  owner's rules are its own: `set()` and `remove()` are for the group's owner, and `set()` checks the amount is a whole number from 1 to 100 000 000.
  A removed budget keeps its row and its passed months, with its amount cleared, so a month told once is never told again, even after the budget
  is set again.
- **The decision is `Budget.pass()`.** The policy on `ExpenseRecorded` and on `ExpenseEdited` (`ExpenseBudgetHandler`, in its own transaction)
  loads the expense, the budget of its category, and what its month spends in the category (read inside the transaction, through
  `IMonthlySpending`), and asks the budget. `pass()` answers the budget unchanged when no budget is set, the month does not spend more than it, or
  the month was passed already; otherwise it records `BudgetPassed` with the month passed. The members to tell are the group's current members,
  read by the policy when the month passes.
- **Ledger says it in its public words.** `BudgetPassedHandler` turns the domain event into the integration event `BudgetPassed`
  (`SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents.ts`, declared in `conventions/integration-events.yaml`), through the outbox.
  The existing link Ledger → Notifications carries it; no relationship is added.
- **Notifications makes one notice per member.** `BudgetPassedIntegrationHandler` issues a `budget` notice to each member named, the payer included,
  with the month's spending as its amount. The notices table keeps one row per person, group, category and month (`budget_key`, a unique index), so
  a fact that comes again after a restart, which the bus's in-memory inbox does not remember, makes no second notice. This is the same store key an
  expense's notice has (ADR 0017): a natural key of the notice, not a record of the messages handled.
- **Categories are a value of the expense.** `Category` is one of the eight, given as `category` on an expense and on a recurring expense (whose
  expenses carry it), and `other` when none is given. The expenses and the recurring expenses recorded before the request are `other` by the column's
  default.
- **The API is request 24's.** `PUT /groups/{id}/budgets/{category}` and `DELETE` answer `2xx`, `GET /groups/{id}/budgets` answers the budgets in the
  order of the categories, each with `spent` for the current month in UTC. A non-member is `404`, a member who is not the owner is `403`, a refused
  category or amount is `422`, and removing a budget that is not set is `404`.

## Consequences

- A new aggregate, two domain events and an integration event: the Lite profile admits each by this record (`yarn architecture profiles`).
- The published language gains `BudgetPassed`, version 1; no event it replaces changes.
- The expense's `ExpenseEdited` domain event, which had no subscriber, now has one.
- Notifications reads no budget: each notice carries what the policy decided, so the notice is made from the fact alone.
- A month passed while the server is down is told when the policy next runs, which is when the expense that passed it is relayed: the decision
  is made on the expense's own fact, never by a sweep.

## When to revisit

When a budget must tell a month that passed without an expense (a sweep at the month's end, which would read every budget), when the spending of a
month must count the expenses of other categories (a budget over several categories), or when a notice must be made again if a budget is set lower
after it passed (the request says it is not, so the passed months are kept for good).
