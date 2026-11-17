# 9. A notice is made from the ExpenseRecorded fact, and nothing else of Ledger's

## Context

Request 17 tells each member of an expense's split but its payer, soon after the expense is recorded, and lets a person list
their own notices, the most recent first. ADR 5 declared the link from Ledger to Notifications `planned`, decided before the
code that carries it: Tally's first integration event, `ExpenseRecorded`, published through the outbox. The storm for the
feature (`conventions/storms/notices.yaml`) decided how the fact reaches Notifications, how a notice is made once per member,
and that edits and deletions are told to nobody.

## Decision

- **Ledger publishes `ExpenseRecorded`** (T9), declared in the published language (`conventions/integration-events.yaml`): the
  expense it announces (`expenseId`, the id it was born with), its group, its payer and each member's share. Ledger's
  `ExpenseRecordedEvent`, the domain event its aggregate records at creation, now carries the payer and the shares as they
  were recorded, and a reaction in Ledger (`ExpenseRecordedHandler`) publishes the integration event from it. The reaction
  needs nothing from Ledger's store, so a deletion that lands before the reaction runs cannot lose the fact.
- **Notifications makes one notice per share but the payer's** (`ExpenseRecordedIntegrationEventHandler`), each in the
  reaction's own transaction, through the outbox and the bus's delivery once per fact. Nothing in the reaction makes itself
  idempotent by hand: a notice is inserted once, because the fact is handed over once.
- **The link Ledger → Notifications is no longer `planned`** in the context map (`conventions/domain.yaml`): it is carried by
  `integration-event`, under the published language, with an anti-corruption reaction on the Notifications side.
- **Edits and deletions publish nothing new.** `ExpenseEditedEvent` and `ExpenseDeletedEvent` stay Ledger's own facts.
- **A notice is the member's own.** It names a group and an expense, not a membership, so it stays after the member leaves,
  and `GET /v1/notices` reads only the caller's notices, through a query that asks no other context.

## Consequences

- A notice is the fact as recorded: an edit later does not change the notice, and no notice is made for it.
- A member whose share is 0 but who is in the split is still told, with a share of 0. The split is what concerns them.
- The payload of `ExpenseRecorded` is a published contract: a field it needs later is an added optional field, or a new version.

## When to revisit

If notices must show what an edit changed, or a reminder (request 18 onwards) needs Ledger's balances rather than the fact,
at which point a second published fact or a port Notifications owns is decided in a new ADR.
