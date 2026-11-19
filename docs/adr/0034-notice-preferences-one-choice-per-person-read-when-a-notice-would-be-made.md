# 34. Notice preferences: one choice per person, read when a notice would be made

## Context

Request 36 (`api/36-notice-preferences.yaml`) lets a signed-in person turn each kind of notice on or off: `expense` (request 17), `reminder`
(request 18) and `budget` (request 24). Every kind is on until it is turned off, and it may be turned on again. A notice of a kind turned off is
not made for that person from then on; one of a kind turned on again is made from then on; nothing made earlier changes, and nothing missed while
it was off is made later. A reminder not made does not count as made: once reminders are on again, a member who still owes is reminded at the
next run that would remind them. What one person turns off changes nothing for anyone else, and a budget passed in a month is still told once.

The storm (`conventions/storms/notice-preferences.yaml`) decided where the preferences live (Notifications, the only context that tells people),
when they are read (when a notice would be made, so a notice made soon after a change follows the preference in force then), and how a reminder
not made is kept (the watch records a reminder only when one is made). No context and no relationship is added: Notifications already reacts to
Ledger's `ExpenseRecorded` and `BudgetPassed`, and already runs the background sweep.

## Decision

**One aggregate per person, changed by a decision and stored whole.** `NoticePreferences` holds whether each kind is on. A person who has changed
none has no row: `NoticePreferences.defaults` is that state, every kind on, and records nothing. `set(kind, enabled, at)` changes a kind and records
`NoticePreferenceChanged`; setting a kind to the value it has changes nothing. The use case `SetNoticePreference` decides the kind, which must be one
of the three (`InvalidNoticeKind`, answered `400`), and saves the aggregate at the version it was read at (CONC-OPTIMISTIC). It is answered at once,
and needs a signed-in caller. `GetNoticePreferences` answers each kind, in the order above, on or off, to its own caller only.

**The preference is read when a notice would be made.** The reaction to `ExpenseRecorded` leaves out of the split the members who have `expense`
turned off; the reaction to `BudgetPassed` leaves out the members who have `budget` turned off. Each does so in its own transaction, as it already
makes its notices. The background sweep leaves out no one from noting a debt: a debt is noted whatever the preference, since noting is not a notice.

**A reminder not made is not made.** `decideSeeDebt` takes whether a reminder may be made to the member now. When a reminder is due but reminders
are off, the decision answers the state it was given, with no fact: the watch keeps its `notedSince` and its `remindedAt` as they were, so the next
run on which reminders are on sees the debt as lasted and reminds at once. The reminder is recorded only with the notice it makes, as before (ADR 15).

**The store.** The preferences are one row per person in the notices' database, with one boolean column per kind and the version. `turnedOff(kind,
memberIds)` answers the members among those given who have the kind off, in one query; the reactions and the sweep ask it once per run or
reaction. A save is checked against the stored version in the transaction that takes the writers' lock, as the debt watches are (ADR 15).

## Consequences

- Notifications gains a table (`notifications_notice_preferences`), two use cases and one routes file. Its handlers and its sweep each gain one
  port argument, a repository of its own (`INoticePreferenceRepository`), so no other context is asked anything.
- `NoticeKind` becomes the list of the three kinds, from which the type is taken, so the order the preferences are read in is written once.
- The debt watch's decision takes one more input, `remindable`. An existing decision's rule for reminders is unchanged when it is `true`.
- No integration event is added: nothing outside Notifications hears of a preference, as the storm asked. `NoticePreferenceChanged` is a domain
  event of Notifications, published from its own transaction and reacted to by nothing.
- The API is answered as request 36 says: `GET` `200` with the three kinds, `PUT` `204` on a change, `400` for a kind that is none of the three
  (`InvalidNoticeKind`) and for an `enabled` that is not a boolean, and `401` to a caller who is not signed in.

## Rejected alternatives

- **Reading the preference when the notice is listed.** A notice would then be hidden rather than not made, and a notice made before a change would
  change with it. The request says a notice of a kind turned off is not made, and nothing made earlier changes.
- **Marking a reminder "made" when it is due but off.** Then a member who turns reminders on again would wait a full period, against the request's
  rule that the first run after they are on again reminds them.
- **One row per person and kind.** Three columns on one row per person keep the version of the whole preference in one place, so the check that
  two saves do not race is one check, and the read is one row.
- **A new context for preferences.** Only Notifications tells people anything, so a context of its own would add a relationship the storm does not
  need.
