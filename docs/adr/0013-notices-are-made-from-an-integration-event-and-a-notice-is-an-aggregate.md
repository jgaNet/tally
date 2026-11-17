# 13. Notices are made from ExpenseRecorded, and a notice is an aggregate that records NoticeIssued

## Context

Request 17 of Tally (a member of an expense's split but its payer receives a notice with their share, soon after the expense is
recorded; a person lists their own, the most recent first) was stormed before the code (`conventions/storms/notices.yaml`, decided
with the product's owner). ADR 8 declared the relationship Ledger → Notifications as an integration event, `planned`, so that
Notifications learns of an expense without Ledger knowing who is told. ADR 12 made the reaction's handling durable, once per message.

The Lite profile holds a rule where its trigger fires, and brings in an aggregate, a domain event, or a reaction to one of a
context's own domain events only by an ADR. This feature fires four of those triggers, and this ADR records each.

## Decision

- **ExpenseRecorded is Tally's first integration event**, declared in the published language (`conventions/integration-events.yaml`,
  version 1: `expenseId`, `groupId`, `paidBy`, `shares`) and carried in the shared kernel
  (`SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents.ts`). It announces an Expense by its `expenseId`.
  Triggers: `publishes-integration-event` (Ledger).
- **Ledger tells it through its own domain event.** `ExpenseRecordedHandler` reacts to `ExpenseRecordedEvent` (Ledger's domain event,
  recorded by `Expense.register`) and calls `publishIntegrationEvent()`, so the fact is durable in the reaction's transaction and
  published after its commit (EVENT-AFTER-COMMIT). The domain event now carries the shares, so the translation reads nothing back.
  Trigger: `reacts-to-domain-event` (Ledger). Ledger already holds its aggregate's rules (several writers, ADR 6 and ADR 10).
- **Notifications reacts to the integration event.** `NoticesForExpenseHandler` makes one notice for each share whose member is not the
  payer, in its own transaction, with the clock the wiring passes. The payer gets none. Edits and deletions make none: they stay
  Ledger's facts. Trigger: `reacts-to-integration-event` (Notifications).
- **A notice is an aggregate root** (`Domain/Notice/Notice.ts`), created once and never changed, so nothing races it and it has no
  version (CONC-OPTIMISTIC is not triggered: no two commands reach it). Its creation records `NoticeIssued`, the fact the storm lists for
  Notifications. No policy reacts to `NoticeIssued` yet; the storm names it, so it is recorded. Trigger: `uses aggregates` and
  `domain events` in Notifications, which carry no rule of their own beyond the record.
- **A person's notices are a query** (`GetMyNotices`, a Lite use case), read through `INoticeReads` over the notices' table, most recent
  first (by the moment each was made, then by the order it was written). A notice is the person's: nothing reads membership, so it stays
  after they leave the group.
- **The context map is carried**: the link Ledger → Notifications loses its `planned` flag. Settlements → Notifications stays `planned`:
  it is request 19's, and its storm has not been held yet.

## Consequences

- A notice appears after the recording commits: the relay hands the fact out in the same request, and the reaction runs in its own
  transaction, so "soon" needs no background job.
- A notice's `at` is the moment it was made, the reaction's clock at that moment, not the moment the expense was recorded.
- A zero share is a member of the split too: the exact split allows 0, so a member with 0 gets a notice of 0. The storm's rule is "each
  member of its split other than its payer", and that is what is built. This is a product question the storm did not decide, and it is
  recorded here for the owner to say otherwise.
- Ledger's domain event `ExpenseRecorded` gained `shares`; no consumer read the old payload.

## When to revisit

When Notifications' reminder (request 19) reacts to Settlements' facts, the link Settlements → Notifications is carried and the storm of
that request says how. When a second consumer needs ExpenseRecorded's shares in a different shape, a version 2 is appended. When a zero
share should not be told, the rule is changed with the product's owner, in the storm first.
