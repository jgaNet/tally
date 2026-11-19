# 36. A person turns each kind of notice on or off, kept by Notifications and read when a notice would be made

## Context

Request 36 lets a signed-in person say, for each kind of notice (an expense's, request 17; a reminder, request 18; a budget's, request 24),
whether they receive it. Every kind is on until they turn it off, and on again when they turn it on. A notice of a kind turned off is not
made for them from the moment they turn it off; nothing made before changes, and nothing missed while it was off is made later. What one
person turns off changes nothing for anyone else. A reminder that is not made while reminders are off does not count as made: once they are
on again, a member who still owes is reminded at the next run that would remind them. The person reads their own preferences, each kind in
the order the API lists them, and nobody else reads them. The storm of the feature (conventions/storms/notice-preferences.yaml) decided
where each part lives.

## Decision

- **The preferences are a state of Notifications.** A `NoticePreferences` aggregate per person holds one flag per kind, on by default.
  `set()` records `NoticePreferenceChanged` only when a kind changes; `SetNoticePreference` is answered at once and refuses a kind that is
  not one of the three with a 4xx. Notifications is the only context that tells people, so no other context hears of the preference and no
  link is added to the context map.
- **The preference is read when a notice would be made.** The reaction to `ExpenseRecorded` and the one to `BudgetPassed` ask the store,
  in their own transaction, whether the member has the kind on before they make the notice for that member. The sweep that makes a reminder
  asks whether the member has reminders on. So a notice made soon after a change follows the preference in force at the moment it is made,
  and a notice made before a change is not touched.
- **A reminder not made is not counted.** `DebtWatch.sweep()` takes whether reminders are on. Turned off, a lasting debt stays noted and
  nothing is recorded as reminded, so the first run after they are on reminds the member (request 18's rule, unchanged). The debt is still
  noted while reminders are off, which keeps the sweep's memory of it accurate.
- **Reading is the person's own.** `GetNoticePreferences` answers the caller's flags from a read model over the same table, each kind in the
  order of the API; a person never set one has every kind on, with no row.

## Consequences

- A member's notices of a kind are not made while it is off, with no retroactive notice when it is turned on, except a reminder, which the
  product asks for: it is made at the first run after reminders are on, as the storm decided.
- The store keeps one row per person (`notice_preferences`, flags defaulting to on) and checks a version on a save, so two changes at once
  from the same person are decided again rather than lost (CONC-OPTIMISTIC).
- A reaction that is handed the same fact twice after a crash decides again: if the member turned the kind back on in between, the notice is
  made then. That is the preference in force at the moment the notice is made, as the storm decided.

See also: docs/adr/0017 (the expense's notice), docs/adr/0018 (the reminder and its period), docs/adr/0023 (the budget's notice),
docs/adr/0035 (the same shape of a person's state kept by its own context).
