# 27. Notice preferences: each person turns each kind of notice on or off, held by Notifications

Status: accepted (request 36)

## Context

Request 36: a signed-in person says, for each kind of notice (`expense`, request 17; `reminder`, request 18; `budget`,
request 24), whether they receive it. Every kind is on until they turn it off. A notice of a kind turned off is not made for
them from then on; nothing made earlier changes, and nothing missed while it was off is made later. A reminder not made while
reminders are off does not count as made, so the first run that finds them on again reminds a member who still owes. What one
person turns off changes nothing for anyone else. A person reads their own preferences, each kind in the order above.

The storm (`conventions/storms/notice-preferences.yaml`) decided the hot spots before the run: the preferences live in
Notifications, the only context that tells people; a notice reads the preference in force when it would be made (in the
reactions to ExpenseRecorded and BudgetPassed, and at the reminders' run); and the DebtWatch records a reminder only when one
is made, so a reminder turned off stays noted. No context and no relationship is new: the storm's `links` are empty.

## Decision

- **One aggregate per person, in Notifications' Domain.** `NoticePreferences` holds a choice for each of the three kinds. A
  person with no stored row has all three on, so nothing is stored until a person first changes a kind. The table
  `notifications_notice_preferences` has one row per person, with the three flags and an optimistic version.
- **The creation is `register()`, not `create()`.** The creation rule accepts either name. The storm's checker reads a
  handler's calls by name across the context's aggregates, so `create()` would be read as `DebtWatch.create` and
  `Notice.create` as well; `register()` is unique to this aggregate in Notifications.
- **The command and the query.** `SetNoticePreference` (`PUT /v1/accounts/me/notice-preferences/{kind}`, body `{ enabled }`)
  is a Full command: it is asked at once and answered `202` with an operation, for a signed-in caller only. The handler
  registers the person's preferences on their first change, or changes them, and saves them in its transaction. An unknown kind
  is refused by the aggregate (`UnknownNoticeKind`), so the operation ends in ERROR and nothing is stored; a body whose `enabled`
  is not a boolean is refused by the transport with 400. `GetNoticePreferences` (`GET /v1/accounts/me/notice-preferences`) reads
  the caller's own three kinds, in order, from the same table, with a kind that has no row on.
- **NoticePreferenceChanged is in-context.** It is recorded by the aggregate when a choice moves, and published after the
  commit like the other domain events. No other context hears of it, so it is not an integration event and no link is declared.
- **A notice reads the preference in its own transaction.** The reaction to ExpenseRecorded asks, for each member of the split
  other than the payer, whether `expense` is on; the reaction to BudgetPassed asks `budget` for each member. A notice made from
  the moment a kind is turned off is not made; one made before keeps its place. The check is `NoticePreferences.wants()`, which
  answers for a person with no row as for all on.
- **The sweep reads `reminder` and gates the watch.** `SweepDebtsJob` asks the person's reminder preference and passes it to
  `DebtWatch.observe({ …, remind })`. A reminder that is due but not wanted is not made and does not move `lastReminded`, so the
  watch keeps its noting and the first run that finds reminders on reminds, as request 18's rule says. A debt that is noted while
  reminders are off stays noted: noting is not a notice, and the reminder is the only thing the preference holds back.

## Consequences

- A preference change takes effect for the notices made after its commit. A notice made in a reaction that reads the preference
  before the change commits follows the choice in force then; the storm accepted that a notice made soon after a change follows
  the preference in force at its making.
- The reaction to ExpenseRecorded reads one row per member of the split. It is a read in the reaction's transaction, the same
  transaction the notices are saved in.
- Two changes by one person at once: the second sees the stored version it read, and its save is refused with a conflict; the
  command re-reads and re-decides, up to three attempts (CONFLICT_ATTEMPTS), as every command does. A first change at once
  collides on the unique member, and the loser is re-read the same way.
- No data is moved: a person with no preferences row keeps every notice they had.

## When to revisit

When a kind of notice must be delivered by another channel (email, a push) with its own preference, when a preference must
reach another context (a published integration event decided by its own storm), or when a person must be told of a change
they made to their notices.
