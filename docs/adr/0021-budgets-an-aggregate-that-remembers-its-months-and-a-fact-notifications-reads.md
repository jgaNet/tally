# 21. Budgets: an aggregate of Ledger that remembers the months it was passed in, decided by a policy on the expense, told to Notifications as `BudgetPassed`

## Context

Request 24 gives an expense a category (one of eight, `other` when none is given), lets the group's owner set a monthly budget per
category, and tells every member, the payer too, when what a month spends in a category goes over its budget: once for a group, a
category and a month, soon, and whenever the server stops (`api/24-budgets.yaml`). The storm (`conventions/storms/budgets.yaml`) was
decided before the code: a `Budget` aggregate of Ledger per group and category, a policy on `ExpenseRecorded` and `ExpenseEdited` that
asks it to decide, `BudgetPassed` published on the relationship Ledger already has with Notifications, one notice per member.

No new context and no new relationship: Ledger already reads the members and their roles through `GroupMembers` (ADR 5), and already
tells Notifications through an integration event (ADR 14).

## Decision

- **The category is a value of the expense** (`ExpenseCategory`): recorded, edited (an edit gives the expense again, whole, so no category
  is `other`) and kept by a recurring expense for the expenses it records. A value that is not one of the eight is the domain's refusal
  (`InvalidExpenseCategory`, 400); a category that is not a string is refused by shape. Expenses stored before the request are `other`
  (a column with that default). `ExpenseRecorded` and `ExpenseEdited` carry the category and the date.
- **`Budget` is an aggregate of Ledger**, one per group and category, in `Domain/Budget`: `create()` generates its id, `setAmount()` replaces
  the amount, `remove()` takes the amount away, `pass()` adds a month to the months it was passed in and records `BudgetPassed`. A removed
  budget stays stored, without an amount and with its months, so that a budget removed and set again does not pass a month twice.
  Its pure decisions: `decideSetBudget` and `decideRemoveBudget` (the owner only; an amount from 1 to 100 000 000; nothing to remove where
  there is no budget, answered 404) and `decidePassBudget` (the category has a budget, the month spends more than it, the month is not yet
  one it was passed in).
- **A policy decides it is passed.** `ExpenseBudgetHandler` reacts to `ExpenseRecorded` and `ExpenseEdited` in a transaction of its own: it
  reads what the expense's month (UTC, the date's `YYYY-MM`) spends in its category from Ledger's own read model (`spentByCategory`, deleted
  expenses are not there), the budget, and the members through `GroupMembers`, and asks `decidePassBudget`. When it passes, the budget is
  saved over the version it was read at (CONC-OPTIMISTIC) with the month, and `BudgetPassed` goes to the outbox with that save. Setting or
  changing a budget decides nothing: only an expense does.
- **`BudgetPassedHandler` tells the other contexts.** It translates the domain event into the integration event `BudgetPassed`
  (`conventions/integration-events.yaml`, version 1: the group, the category, the month, the budget, what the month spends, and the members to
  tell, as the group had them when it was decided). It announces no thing, so it carries no id of its own.
- **Notifications makes the notices.** `BudgetPassedIntegrationEventHandler` makes one `budget` notice for each member the fact names, in the
  reaction's own transaction, carrying the category, the month, the budget and, as `amount`, what the month spends. The bus hands the fact
  over once; the reaction is not made idempotent by hand.
- **`GetGroupBudgets`** reads the budgets that have an amount, in the order of the categories, with what the current month (UTC, from the one
  clock) spends in each.

## Consequences

- The outbox is still the process's in-memory one (ADR 14, ADR 20). The budget's month and the fact are written in one transaction, but the
  fact is kept in memory until it is relayed: a server stopped between the commit of an expense and the relay of its facts loses them, and
  with them the notices of a month passing its budget; the month is then not marked passed either only when the stop came before the
  policy's own commit, so the next expense that leaves it over the budget still tells it. A stop after the budget commits and before
  `BudgetPassed` reaches Notifications loses that month's notices for good. Closing the gap is a durable outbox in the same transaction as
  the state, which is an architecture change of its own and is not made here.
- What a month "then spends" is read when the policy runs, not when the expense was recorded: an expense deleted in between, or another
  recorded, counts as it stands then.
- A notice is told to the members the group has when the policy decides; a member who joins later is not told of a month already passed.
- The payer of the expense is the member through whom the policy asks `GroupMembers`; if they have left the group by then, nothing is
  decided and nothing is told.

## When to revisit

When the outbox is durable in the same transaction (above), and when a budget should look at more than the month of the expense that
passed it (a budget set while the month is already over it tells nothing until an expense of that month is recorded or edited).
