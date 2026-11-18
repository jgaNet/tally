# 14. A recurring expense is an aggregate of Ledger, and its day names the expense it records

## Context

Request 23 lets a member set up an expense they pay every month (`POST /groups/{id}/recurring`). The background job records its
expense on its day of every month, at the first run on or after the day, once whatever the number of servers on the database and
however often they are stopped and started. A recurring expense whose start day has passed has each day already passed recorded at
the next run. A recurring expense ends, as if stopped, on a day its payer or a member of its split is no longer in the group. The storm
(`conventions/storms/recurring-expenses.yaml`) decided four hot spots: what a recurring expense is, who notices that a day has come,
how a day's expense is recorded once, and what happens when a member has left.

The storm needs nothing outside Ledger. The expense is Ledger's; who may be in a split is read from Groups through `GroupMembers`, and the
group's currency through `GroupCurrency`, both owned ports that already exist (ADR 3, ADR 12). So the context map and
`conventions/domain.yaml`'s context list are unchanged; only Ledger's glossary gains a term.

## Decision

- **A recurring expense is an aggregate of Ledger (`RecurringExpense`).** It holds its payer, description, amount, `startsOn`, the
  split as it was given (`SplitInput`, one of the three kinds), and `next`, the day it records next. `setUp` checks the start day
  (a real day, 1 to 28 of its month, no more than 365 days from today) and decides the split as an expense does, so the same refusals
  apply. `stop` is allowed to its payer or the group's owner, and deletes it.
- **The sweep notices a day that has come, and the aggregate decides it.** `RecurringExpenseSweepJob` runs from the process timer with
  the debt sweep (ADR 10), in a context of its own, every `JOBS_INTERVAL_SECONDS`. It takes the day from the one clock. For each recurring
  expense whose `next` is no later than today it records the days that have come, one transaction a day, until none is due. Each day is
  decided by `recordDay`, which takes the current members (read through `GroupMembers` inside the transaction, not by the aggregate) and
  either moves `next` on by a month and records `RecurringExpenseDayCame`, or, when the payer or a split member has left, records
  `RecurringExpenseEnded` and is deleted. Nothing is decided by a read.
- **The day's expense is recorded once, under the id the day was born with.** `recordDay` generates the id of the expense the day will
  record and carries it in `RecurringExpenseDayCame`, with the payer, description, amount, split and the members the decision checked. The
  policy on that fact (`RecurringExpenseDayCameHandler`) first looks the id up: an expense already recorded under it is left as it is, so
  a redelivered fact records nothing twice. Otherwise it records the expense under that id in its own transaction, counts it into the
  balances, and publishes its `ExpenseRecorded` from the outbox after the commit (EVENT-AFTER-COMMIT).
- **The optimistic check lets one server win.** The sweep saves the recurring expense at its version (CONC-OPTIMISTIC). Two servers that
  decide the same day race on that save; the one that loses is rolled back with its fact and reads the day again, up to three attempts. On
  the second read the day is no longer due, so nothing is recorded twice.
- **The expense takes an id it was given.** `Expense.create` accepts the id a recurring day carried, and generates one only when none is
  given. This departs from the rule that an aggregate generates its own identity in `create()` (DOMAIN-IDENTITY): the identity is born
  once, in the decision that names the day, and the reaction builds the expense on it, as a receiving context builds on an id it was
  given. The departure is contained to that one optional parameter; every other `Expense.create` generates its id.

## Consequences

- A day is recorded once across any number of servers and any number of restarts. A day whose fact a crash kept from being published is
  recorded on the next relay, and the policy's check makes that redelivery harmless.
- The members a day's expense is recorded among are the ones its decision checked, carried in the fact, so a member who leaves between the
  decision and the reaction does not make the reaction refuse an expense already decided. The expense is still split by the rule in force
  when it is recorded (request 10): the split is given to `Expense.create` as it was set up.
- A recurring expense that has been stopped or ended records nothing more, and its expenses stay. No read decides a day.
- The sweep reads the due days outside any transaction (`findDueIds`), and each day in a transaction of its own, so a long catch-up is
  many short transactions rather than one long one.

## When to revisit

If a recurring expense should be able to change its amount, split or payer, that is a new request: an edit changes the next day's expense
and none of the days already recorded. If the day should be recorded at the moment a member leaves rather than at the next run, the
decision moves into the leave command and the sweep stays as it is. If expenses for many groups make the sweep slow, the due days can be
read through an index on `next_on`, which the table already has.
