# 25. A receipt is an aggregate of Ledger, kept in an outside store behind a port of Ledger

## Context

Request 26: a payer or the group's owner attaches a JPEG or a PNG of at most 2 MB to an expense. Tally keeps no files: the file is kept in a
receipts store the server is started with (`RECEIPTS_URL`), which answers `201 { id, url }`, and a member reads the receipt's type, its size in
bytes and the link. The storm (`conventions/storms/receipts.yaml`) was decided before any code: the store is behind a port Ledger owns; a receipt
is its own aggregate, one per expense, and not a field of the expense (a receipt is not an edit, so the expense keeps its version); the file's type
and size are read by the receipt from the bytes the transport hands over, and a refused file is never sent to the store.

The storm adds no context and no relationship between contexts. The link Groups → Ledger (GroupMembers, ADR 0004) already carries who may be
in an expense's split, and the receipt asks the same members and the expense's payer through Ledger's own read model, as an edit does.

## Decision

- **A `Receipt` is an aggregate of Ledger** (`Domain/Receipt`), one per expense, identified by a generated id, and unique by its expense in the
  store. Its rule is the expense's rule for an edit: its payer or the group's owner may attach it, among the group's current members; any other
  member is refused `403`, and a member who is not in the group sees the expense as not existing (`404`).
- **The decision is made before the store is asked.** `Receipt.check()` applies the rule and reads the file (`ReceiptFile`): its size (1 byte to
  2 097 152 bytes) and its type from the first bytes (`FF D8 FF` for a JPEG, the eight PNG signature bytes for a PNG). A refusal is `422` with the
  rule's name (`ReceiptSizeOutOfRange`, `ReceiptNotJpegOrPng`) and nothing is sent. Only then is the store asked.
- **The store is a port Ledger owns.** `IReceiptStore.keep()` (`Application/Ports`) answers the link the file is read at, as a plain value the
  receipt takes and checks: a link that is not empty is kept, and an empty one is a programming error. `HttpReceiptStore` calls
  `POST {RECEIPTS_URL}/files` with the file as the body and its type as `Content-Type`, takes `201 { id, url }` and returns the `url`. Any other
  answer, a body that is not that, a failure to reach it, or no answer within 5 seconds, is `ReceiptStoreUnavailable` (`422`), and nothing changes.
  With no `RECEIPTS_URL`, every receipt is refused.
- **A receipt replaces the one its expense had.** `Receipt.attach()` makes the first receipt of an expense; `reattach()` makes the next one, with the
  same identity, read at the version it was stored at, and keeps the same rule. Each records `ReceiptAttached`, which nothing reacts to, so it is a
  domain event with no subscriber and no integration event. The expense is not written by a receipt, so its version does not move.
- **The use case reads the expense over Ledger's own read model, on a connection of its own.** A command's transaction holds the shared connection,
  and a read on it would wait for itself (as the cross-context read models do, `Bootstrap/Fastify/readModels.ts`); the attach command therefore
  reads the expense through `ledgerReadModel`, and the query through the shared one.
- **Concurrent writers are answered by the store.** The table keeps one row per expense (`expense_id` unique). A save of a receipt read at a
  version another writer has moved past, or a second first receipt for an expense, changes nothing and answers a conflict (`409`, retried from a
  fresh read, CONC-OPTIMISTIC).
- **The API is request 26's** (`api/26-receipts.yaml`): `PUT /v1/expenses/{id}/receipt` with the file as the body, `application/octet-stream`,
  answered `204` or a named refusal; `GET /v1/expenses/{id}/receipt` answers `200 { type, size, url }`, or `404` when the expense has none.
- **The transport keeps the bytes and leaves the size to the rule.** The route parses `application/octet-stream` into a buffer up to 8 MiB, a guard
  against reading an unbounded body; the Receipt refuses any size above 2 MB by name. A body above 8 MiB is refused by the transport (`413`).
- **Method names are the storm checker's test.** The conventions check reads a use case's aggregate from the behaviours its text calls, by method
  name on any receiver, and a behaviour is a method that records an event. `create()` and `replace()` were already called by
  `SplitTemplates.ts` (ADR 0024), so a receipt's behaviours are `attach()` and `reattach()`: otherwise feature 25's command reads as a receipt's and
  its storm is no longer met.

## Consequences

- A new table, `receipts`, in the application's file: one row per expense that has a receipt.
- One new port (`IReceiptStore`) and one adapter over an outside system, configured by `RECEIPTS_URL`, read at each call.
- One domain event (`ReceiptAttached`), one aggregate and one value object in Ledger; no integration event, so
  `conventions/integration-events.yaml` is unchanged.
- A receipt that is replaced leaves its file in the store: the store is not asked to remove it, as the request does not say so.
- The store is called inside the command's transaction, as the payment provider is: a slow store holds the file's turn for up to 5 seconds.

## When to revisit

When a receipt must be removed or read by someone outside its group, when the store must remove the file a receipt replaced, or when a receipt
must be attached through a different file type (the request allows only a JPEG or a PNG).
