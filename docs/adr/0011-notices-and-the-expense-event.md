# 11. Notices: Ledger publishes ExpenseRecorded, and Notifications makes one notice per member

## Context

Request 17 tells each member of an expense's split but its payer about their share, soon after the expense is recorded, and
lets a person list their notices. ADR 5 declared Notifications and the link Ledger → Notifications (`planned`), decided that
the notice comes from a fact Ledger publishes (`ExpenseRecorded`, through the outbox), and that an edit or a deletion tells
nobody. The storm (`conventions/storms/notices.yaml`) decided the hot spots before the run; what the code still owed was the
published event, Ledger's reaction that publishes it, Notifications' reaction and its read, and the relationship's flag.

## Decision

- **The relationship is carried, so it is no longer `planned`.** Ledger → Notifications (`integration-event`) loses its flag
  in `conventions/domain.yaml`. Settlements → Notifications stays `planned` until the reminder request.
- **`ExpenseRecorded` is Tally's published event, declared in `conventions/integration-events.yaml`** with its publisher
  (Ledger), the thing it announces (`Expense`, by `expenseId`, the id it was born with) and its payload: the expense's id,
  group, payer and shares. Its code is `src/SharedKernel/Application/IntegrationEvents/LedgerIntegrationEvents.ts`.
- **Ledger's domain event carries its shares.** `ExpenseRecordedEvent` (Ledger's own, not published) gains `shares`, so the
  reaction that publishes the integration event reads the split as it was recorded. Reading the expense back in that reaction
  would read an edit made after it, and a notice would say what the edit said, not what was recorded.
- **Ledger's reaction publishes the integration event.** A domain-event reaction calls `publishIntegrationEvent` in its own
  transaction (ADR 30, EVENT-AFTER-COMMIT), so the fact reaches the outbox with the reaction's writes and is relayed after the
  commit. Nothing in Ledger's command handler changes.
- **Notifications makes one notice per member.** Its reaction to `ExpenseRecorded` builds a `Notice` for each share whose
  member is not the payer, saves them and publishes each `NoticeIssued` in the same transaction. A `Notice` is an aggregate of
  Notifications with `create()`, which records `NoticeIssued`; its id is generated there. The bus hands the fact to the
  reaction once, so no key or flag makes it idempotent by hand. A unique index on `(expense_id, member_id)` is a durable
  guard on top of that.
- **A person reads their notices** through `GetMyNotices` (`GET /v1/notices`), a query over Notifications' read model, most
  recent first, for the signed-in caller only. The read asks no other context and filters by the caller alone, so a notice
  stays theirs after they leave the group.
- **No new context and no other relationship.** The storm's contexts, events and link are the ones ADR 5 declared; this
  feature adds the one published event and carries the one relationship.

## Consequences

- An expense recorded is announced within the relay's pass after its commit: no job waits for it, and a crash before the
  relay delays the notices until the next start (ADR 24), without losing or doubling them.
- Edits and deletions still tell nobody: only `ExpenseRecorded` is published, as ADR 5 decided.
- A notice is made for a share of zero too, when the split has one: the member is in the split, and the request says each
  member of the split but the payer receives one.
- The `ExpenseRecorded` payload is the first published contract a second context reads. A later change to it is a new version
  in `conventions/integration-events.yaml` (CTX-PUBLISHED-LANGUAGE), not an edit of this one.

## When to revisit

When a reminder needs Settlements' outstanding debts (the planned link Settlements → Notifications), or when an edit or a
deletion must reach the members (a new published event, decided by its own storm), or when a notice must be read as
read or unread.
