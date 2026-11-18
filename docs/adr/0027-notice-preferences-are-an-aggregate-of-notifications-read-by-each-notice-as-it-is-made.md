# 27. Notice preferences are an aggregate of Notifications, read by each notice as it is made, and a reminder not made is not recorded

## Context

Request 36 lets each person turn each kind of notice (`expense`, `reminder`, `budget`) on or off. Every kind is on until
turned off; a notice of a kind turned off is not made for that person from then on; a reminder not made does not count as
made, so the first run that finds reminders on again reminds a member who still owes. What one person turns off changes
nothing for anyone else.

The storm (`conventions/storms/notice-preferences.yaml`) decided three hot spots: where the preferences are (Notifications,
the only context that tells people, so no other context hears of them), when they are read (when a notice would be made, in
the reactions to `ExpenseRecorded` and `BudgetPassed` and at the reminders' run), and what a reminder not made does (the
watch records nothing, so it stays noted). It declares no new context and no new relationship: the feature uses the links
Ledger → Notifications and Settlements → Notifications already carry (ADR 5, ADR 9, ADR 15), and the sweep's port to
Settlements (ADR 10). The context map does not change.

## Decision

- **The preferences are an aggregate of Notifications, `NoticePreferences`, one per person.** It holds one flag per kind,
  every flag on for a person who never changed one, and no row until the first change. `set` turns a kind on or off from the
  time the handler passes (DOMAIN-ONE-CLOCK) and records `NoticePreferenceChanged`; setting a kind to what it already is
  changes nothing and records nothing. A kind that is not one of the three is refused as `InvalidNoticeKind` behind the 202.
  The aggregate is opened by a static `open` that records nothing, as `DebtWatch.open` does for a watch nobody has seen yet.
- **A command, and a query of the person's own.** `SetNoticePreference` is answered 202 and read at the operation, as every
  command is (request 1); the caller is the one whose preferences change, so no one else's are reachable. `GetNoticePreferences`
  answers the three kinds in order, on or off, to the signed-in person only.
- **Each notice reads the preference when it would be made.** The reaction to `ExpenseRecorded` skips a member who turned
  expense notices off, and the reaction to `BudgetPassed` skips a member who turned budget notices off; each reads the
  preference in its own transaction, so a notice made after a change follows the change, and one made before is not changed.
  Nothing missed while a kind was off is made later. The budget is still passed once for the group: only the notice of the
  member who turned it off is not made.
- **A reminder not made is not recorded.** `DebtWatch.remindIfDue` takes `remindable`: a member who turned reminders off is
  not reminded and the watch records nothing, so the debt stays noted and the first sweep that finds reminders on again
  reminds them, under request 18's rule, unchanged. The sweep reads the preference in the watch's transaction.
- **Storage.** One table, `notice_preferences`, one row per person with a flag per kind, the owner unique; two first changes
  at once meet on the insert and the bus answers the conflict by reading again (CONC-OPTIMISTIC).

## Consequences

- The preference is read by three reactions (two of them tell members, one sweeps for debts), and each reads it as the one
  place a person's kinds of notice are kept. A person with no row has every kind on, so a new kind is on for everyone until
  it is turned off.
- The notice read model and the reminder rule are unchanged for anyone who never turns a kind off.
- No event is published to another context: `NoticePreferenceChanged` stays inside Notifications and is recorded in the
  outbox like the other domain events of the context.

## When to revisit

If a kind of notice should be sent through another channel (an e-mail, a push), the preference is read where the channel is
decided, and a relationship to that channel is declared then. If a preference should be per group rather than per person, it
is a new aggregate keyed by the group, not a change of this one.
