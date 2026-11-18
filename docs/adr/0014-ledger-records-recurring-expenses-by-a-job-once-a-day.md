# 14. Ledger records a recurring expense's days by a background job, each day once (no new link: the Groups → Ledger link, carried)

## Context

Request 23 has a member set up an expense they pay every month, whose expenses are recorded on its day of every month by the
background job, at its first run on or after the day, never by a read; a recurring expense whose days have passed records each
of them at the next run; each day has one expense however many servers run, even when a server stops at any moment; and it ends
when its payer or a member of its split has left. The storm `recurring-expenses` decided the hot spots with the product's owner.
This ADR records what the storm left to the code.

## Decision

- **A recurring expense is an aggregate of Ledger** (`RecurringExpense`), beside `Expense`. It keeps its payer, its group's
  currency, its description and amount, the split as it was given, and `next`, the day of the next expense it will record.
  Who may stop it is decided on the aggregate, as who may change an expense is.
- **The job decides the days** (`RecordRecurringExpensesJob`), scheduled by the composition root every `JOBS_INTERVAL_SECONDS`
  beside the reminders. It takes the due ones at the run's instant and decides each day in a transaction of its own:
  `settleDay` either leaves the day for later (`waiting`), ends the recurring expense when its payer or a split member is no
  longer a member (`ended`: `RecurringExpenseEnded`, no expense, the row removed), or records the day (`recorded`:
  `RecurringExpenseDayCame`, and `next` a month on). A day that lost a race is decided again, up to three attempts, the third
  conflict being the day's refusal (CONC-OPTIMISTIC); the next run tries again.
- **The expense of a day is a policy on its fact.** The day's expense id is made by the aggregate, once, with the day, and the
  fact carries it. The handler `RecurringExpenseDayCameHandler` records the `Expense` with that id, in its own transaction,
  unless an expense with the id is already stored, so a fact delivered again records nothing twice (EVENT-AFTER-COMMIT).
  `Expense.create` takes the id a fact carries; without one it generates its own, as before.
- **Membership is asked with no caller.** The job cannot ask as the payer, who may have left, so `IGroupMembers` gains
  `currentMemberIds(groupId)`, answered by Groups' `membersOfEveryGroup` read model. The group's currency is kept on the
  recurring expense when it is set up, so the job and the policy never ask for it.
- **Reads are read models.** `GET /recurring/{id}` and `GET /groups/{id}/recurring` answer to a member of the group only, as
  an expense does, and return the split under the key it was given.

## Consequences

- No new context and no new relationship: the Groups → Ledger link carries `GroupMembers` and `GroupCurrency` as before,
  plus the caller-less membership read `currentMemberIds`, which is the same Groups read model, a new method on the same port.
- A day is dated by its day, not by when it is recorded, so a catch-up run records the earlier days with their own dates.
  Membership is the membership at the run, since Groups keeps no history of who was a member on a past day.
- If the payer or a split member leaves between a day's decision and the policy that records its expense, the expense is refused
  and logged; the day is already recorded in the recurring expense. That window is one outbox relay, and it is accepted.

## When to revisit

When a day must be recorded with the membership of that day, not the run's (then Groups must keep when each member left, and the
day is decided against that history); or when one job per recurring expense becomes too slow for the runs, in which case the due
days are batched.
