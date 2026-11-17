# 9. Notifications tells each member of an expense from Ledger's ExpenseRecorded (the Ledger → Notifications link, carried)

## Context

ADR 6 declared Notifications, empty, and decided (T9) that an expense's notice comes from a fact Ledger publishes,
`ExpenseRecorded`, Tally's first integration event, through the outbox. Request 17 (notices) is the first feature that
needs it: each member of an expense's split but its payer receives one notice with their share, soon after the expense is
recorded, never two, even when Tally is stopped at any moment and started again; a person lists their own notices. Its
storm, `notices`, decided the hot spots: Notifications learns of an expense from the published event, relayed from the
outbox after the commit; the outbox and the bus's idempotent delivery carry the fact once to the reaction; edits and
deletions are not told; a notice is its recipient's, not tied to their membership.

## Decision

- **`ExpenseRecorded` is published** (version 1 in `conventions/integration-events.yaml`): the expense's id (the thing it
  announces), its group, its payer, its amount and each member's share in the order of the split, so Notifications never
  asks Ledger back. Ledger's domain event `ExpenseRecorded` carries the amount and the shares too, and a domain event
  handler of Ledger (`ExpenseRecordedHandler`) restates it in the published words through `publishIntegrationEvent()`,
  in its own transaction, so it goes out through the outbox after the commit. `ExpenseEdited` and `ExpenseDeleted` stay
  Ledger's own.
- **A `Notice` is an aggregate of Notifications**, one per recipient and fact: its recipient, its kind (`expense`), the
  group, the expense, the recipient's share and when it was made (the application's clock, in the reaction). The
  reaction (`ExpenseRecordedIntegrationEventHandler`, the anti-corruption layer) makes the notices of an expense in its
  own transaction, and they are stored in a `notices` table of the application's file.
- **A notice is made once from the fact** (the language's own definition of a Notice). The outbox and the bus's inbox
  hand the fact to the reaction once while Tally runs; but the inbox is the in-memory bus's, and a process stopped after
  the reaction committed and before the outbox entry was acknowledged hands the fact out again at the next start, to a
  new inbox. So the rule is the domain's, not a guard added to the handler: `Notice.forExpense` is given who already
  holds a notice of the expense (a fact the repository answers about the collection, as `findByEmail` does) and does
  not tell them again, and the table holds one notice per expense and recipient, so two writers at once meet a
  ConcurrencyConflict instead of a second notice.
- **Reading one's notices asks no other context**: `GET /v1/notices` reads the `notices` table for the signed-in caller,
  the most recent first; a notice stays after its recipient leaves the group.

The link Ledger → Notifications is no longer `planned` in the context map.

## Consequences

- A notice appears as soon as the reaction runs after the expense's commit, not at the background job's relay.
- The payload of `ExpenseRecorded` is a promise: a field removed, renamed or retyped is a version 2.

## When to revisit

When the bus's inbox is made durable (a broker, or an inbox table written in the reaction's transaction): the
already-told fact then only guards against two writers, and may stay as the table's uniqueness alone.
