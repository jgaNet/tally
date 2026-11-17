# 17. An expense recorded is told to Notifications, which issues one notice per member but the payer

## Context

Request 17: when an expense is recorded, each member of its split other than its payer receives a notice (the group, the expense, their
share); a signed-in person lists their own notices, the most recent first. The storm (`conventions/storms/notices.yaml`) decided that
Notifications learns of it from an integration event Ledger publishes, that one notice per member holds across crashes through the outbox
and the bus's inbox, that edits and deletions are not told, and that a notice is the person's and independent of membership.

## Decision

- **`ExpenseRecorded` is Tally's first integration event** (`SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents.ts`,
  declared in `conventions/integration-events.yaml`): expense id, group id, payer and the shares. Ledger's domain event
  `ExpenseRecordedEvent` now carries the shares, and Ledger's `ExpenseRecordedHandler` translates it; it leaves through the outbox after
  the commit. The context map's Ledger → Notifications relationship (published language, anti-corruption layer) is no longer `planned`.
  This brings Ledger the trigger `reacts-to-domain-event` and `publishes-integration-event` of the Lite profile (EVENT-AFTER-COMMIT).
- **`Notice` is an aggregate of Notifications** (trigger `reacts-to-domain-event`: it records `NoticeIssued`). It carries the account it
  is for and nothing of membership, so it stays after they leave; it is never changed. `ExpenseRecordedIntegrationHandler` makes one per
  share whose member is not the payer, in its own transaction, with the one clock's now as `at`.
- **One per member, even across a restart.** The bus's inbox is in memory, so a fact handed again after a restart would reach the
  reaction again. The store keeps `UNIQUE (account_id, expense_id)` and inserts with `ON CONFLICT DO NOTHING`; `NoticeIssued` is
  published only for a notice stored. This is the store's key, not a check by hand in the reaction.
- **Soon.** The commit relays the outbox at once, and the reaction's own commit does the same; nothing waits for the background job.
- **`GET /v1/notices`** answers the caller's notices (`GetMyNotices`), `at` descending, then the order made, from the one table.

## Consequences

- Notifications' query reads nothing of other contexts; a person who leaves a group keeps their notices.
- Edits and deletions of an expense tell nobody.

## When to revisit

When a notice is read, deleted or delivered elsewhere (email, push), or a second kind of notice (reminders, request 18) shares the table.
