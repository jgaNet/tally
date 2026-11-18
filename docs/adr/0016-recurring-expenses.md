# 16. Recurring expenses: an aggregate in Ledger, and the background job records each day once

## Context

Request 23 has a member set up an expense they pay every month (the rent): its description, its amount in the group's currency, its
split as given (one of the three), and the day of its first month. On its day of every month, from then on, the expense is recorded
for it: dated that day, paid by its payer, with its split, once however many servers run, and only by the background job, never by a
read. A recurring expense ends when its payer or a member of its split has left the group, and is stopped by its payer or the owner.

The storm (`conventions/storms/recurring-expenses.yaml`) decided the hot spots before the run: the recurring expense is an aggregate of
its own in Ledger; the job is the one that notices a day has come; a day is recorded once through an optimistic check on the
recurring expense and a policy on the day's fact, delivered by the outbox; and a departed member ends it. The storm names Ledger's
existing link to Groups (GroupMembers) and no new context or relationship, so none is declared here.

## Decision

- **No new context and no new relationship.** Ledger already asks Groups who is a member (GroupMembers, ADR 3). The recurring expense
  lives in Ledger beside the expenses it records (`Domain/RecurringExpense`), and the conventions are not changed.
- **The split is kept as it was given.** `RecurringExpense` holds its payer, description, amount, `startsOn`, `next` (the day of its next
  expense) and the split in the form it was given (`splitBetween`, `splitExactly` or `splitByShares`). Each day's split is computed
  again from it with `Split`, so an equal or a shares split keeps the same rule as an expense recorded by hand.
- **`startsOn` is checked at set-up** (`StartsOn`): a real day, from the 1st to the 28th so every month has it, no more than 365 days
  before or after today (UTC). The refusal is `InvalidStartsOn`.
- **The background job records each day.** `RecordRecurringExpensesJob` runs every `JOBS_INTERVAL_SECONDS`, reads the recurring expenses
  whose `next` has come, and for each day that has come, one transaction at a time, from the first: the aggregate's `recordDay()` moves
  `next` to the same day of the next month and records `RecurringExpenseDayCame`, or, when the payer or a member of the split is no longer
  a member, records `RecurringExpenseEnded` and removes the recurring expense. Two servers meet the optimistic version (CONC-OPTIMISTIC):
  the loser re-reads, sees `next` moved on, and records nothing for that day. A start already passed gets every day that has come at its
  first run.
- **The day's expense is recorded by a policy on the fact, in its own transaction.** `RecurringExpenseDayCameEventHandler` records the
  expense with the identity the fact carries, and publishes `ExpenseRecorded` as an expense does. A fact delivered again finds its expense
  already recorded (`findById`) and records nothing, so the bus's at-least-once delivery records each day once.
- **The identity of the day's expense is born with the day.** `RecurringExpense.recordDay()` generates the expense's id and the fact carries
  it, so that the redelivery can find it. `Expense.create()` takes that id when given (otherwise it generates one, as before). This departs
  from "an aggregate generates its own identity" for one case, the recurring expense's own days, and is accepted for the redelivery check it
  makes possible.
- **The clock is the application's.** The Ledger wiring now takes the clock the composition root is given (`ledgerModuleWith(rates, clock)`),
  as the job does, instead of the system clock in each handler. In production it is the same system clock; a test moves it.

## Consequences

- A member who leaves between the job's check and the day's policy can make the policy refuse that day's expense (`NotAGroupMember`). It is
  logged as a reaction that failed, and that day's expense is not recorded; the recurring expense is not ended by it, as the next run sees
  the member gone. Leaving needs a zero balance (request 9), so this window is a few milliseconds of a run.
- A day is decided in a transaction of its own, so a start long passed costs one transaction per month it lacks, at the first run.
- The job reads the recurring expenses due by day with no transaction; a recurring expense set up while a run is reading is picked up by the
  next run.

## When to revisit

When the job has to be sharded across servers (then the due recurring expenses need a claim, not only the version), when a recurring
expense may be in another currency (the rate would be taken on each day, as an expense's is, ADR 15), or when the day's expense should be
recorded inside the job's own transaction rather than by the policy.
