# 19. Budgets are an aggregate per category, and a passed month is published once through the existing link to Notifications

## Context

Request 24 of Tally (an expense has a category; the owner sets a monthly budget per category; when an expense is recorded or edited and
its month then spends more than its category's budget, every member is told, once for that month) was stormed before the code
(`conventions/storms/budgets.yaml`, decided with the product's owner). The storm puts the budget in Ledger, the policy that checks it on
the expense's facts, and the notice in Notifications, through the relationship Ledger already has with it (ExpenseRecorded, ADR 13).

Two things are new to the application as a whole, so they are decided here rather than left to the storm: the published language
gains a contract (`BudgetPassed`, `conventions/integration-events.yaml`), and the relationship Ledger → Notifications carries it. No
context and no relationship are new; the map (`conventions/domain.yaml`) already declares that link and its mechanism.

The Lite profile's `several-writers` trigger fires again (the owner sets and removes a budget, and the expenses that pass it are written
by their payers and their owner), and the `reacts-to-domain-event` trigger fires on `ExpenseRecorded` and `ExpenseEdited`. The aggregate
and the policy are what those rules ask for, as in ADR 18.

## Decision

- **A `Budget` is an aggregate of Ledger**, one per group and category (`src/Contexts/Ledger/Domain/Budget/Budget.ts`). It holds its group,
  its category, its amount (absent once removed), the months it has passed, and the version it was loaded at. `set` records `BudgetSet`,
  `remove` records `BudgetRemoved`. Removing a budget keeps its passed months, so that setting it again does not make a month's notice
  twice: "a notice for a group, a category and a month is made once" holds across removal.
- **A month is passed by a decision of the aggregate.** `Budget.judge(month, spent, members, now)` records `BudgetPassed` when the budget
  is set, the month's spending is more than the amount, and the month is not among those passed; it then remembers the month. A month that
  goes further over, or comes back under and over again, passes nothing more. Setting or changing a budget passes nothing.
- **A policy on `ExpenseRecorded` and on `ExpenseEdited`** reads the expense's category and month from the fact (both now carry their
  category and date), reads what the month spends in the category (`IExpenseStore.spentIn`, Ledger's own read model over the committed
  expenses, deleted ones left out), reads the group's members through `GroupMembers` for the members to tell, and asks the budget to judge.
  The reaction runs in its own transaction (ADR 30 of the reference); a conflict on the budget's version is re-read and re-decided, up to
  `CONFLICT_ATTEMPTS`, as a command is.
- **A policy on `BudgetPassed` publishes the integration event `BudgetPassed`** (`src/SharedKernel/Application/IntegrationEvents/BudgetIntegrationEvents.ts`),
  carrying the group, the category, the month, the budget, what the month spends and the members to tell. It is made durable with the
  budget's change and relayed after the commit (EVENT-AFTER-COMMIT); the bus delivers it once.
- **Notifications makes one notice per member** from `BudgetPassed`, in its own transaction, with the kind `budget`: its category, month,
  budget and what the month spends (its `amount`). The payer is one of the members and receives one too.
- **The category is a value of the expense** (`Category.ts`): one of eight, `other` when none is given. A recurring expense keeps one for
  its expenses. The expenses and recurring expenses kept before this request have `other`, by a backfill of the side table that keeps
  each one's category (`expense_categories`, `recurring_categories`), as the other facts added later are kept (ADR 8 and request 21).

## Consequences

- `conventions/integration-events.yaml` declares `BudgetPassed` version 1, published by Ledger, announcing no thing (no id is born with it).
- `conventions/domain.yaml` names the terms `Category`, `Budget` and `BudgetNotice`, and the Ledger → Notifications relationship's purpose now
  carries the budget. The relationship's mechanism and patterns are unchanged, so the map needs no new declaration.
- The storm `conventions/storms/budgets.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
