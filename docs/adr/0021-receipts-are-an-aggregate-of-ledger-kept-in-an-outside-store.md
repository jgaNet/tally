# 21. Receipts are an aggregate of Ledger, one per expense, kept in an outside store behind a port Ledger owns

## Context

Request 26 of Tally (a payer or the owner of an expense attaches a JPEG or a PNG of at most 2 MB to it, and a member reads its type, size and
link) was stormed before the code (`conventions/storms/receipts.yaml`, decided with the product's owner). The storm puts the file outside Tally:
the receipts store, an API of its own at `RECEIPTS_URL`, which answers `201 { id, url }` to a file sent to `POST /files`. Tally keeps no file.

No context and no relationship are new. The receipt is Ledger's, and what it asks of Groups is already declared and carried: the map
(`conventions/domain.yaml`) has Groups → Ledger through `GroupMembers` (an owned port), and the storm says so ("already carried"). The store is an
outside service, as the rates service is (ADR 17): it is not a context, so the map does not declare it, and its adapter is Ledger's infrastructure.

The Lite profile's `several-writers` trigger fires for Ledger (a receipt is attached, replaced by another, and read at once), so the aggregate
comes in by this ADR, as in ADRs 18, 19 and 20.

## Decision

- **The store is a port Ledger owns**, `IReceiptStore` in `src/Contexts/Ledger/Application/IReceiptStore.ts` (the storm's `ReceiptStore`). `keep` takes the
  file and its type and answers the file's id and link, or nothing: nothing when the store is not configured, does not answer within 5 seconds, or
  answers other than `201 { id, url }` with both strings. Its answer is a plain value the receipt takes, so the domain stays pure
  (DOMAIN-NON-DETERMINISM). The adapter is `HttpReceiptStore`, built by the composition root over `RECEIPTS_URL`.
- **A receipt is its own aggregate**, `Receipt`, one per expense (`src/Contexts/Ledger/Domain/Receipt/Receipt.ts`). It holds its expense, the store's
  file id and link, its type and size, and the version it was loaded at. `attach` records `ReceiptAttached`; `reattach`, by a new file, records it again
  and keeps the receipt's id. The expense is not touched: it keeps its version (request 26: a receipt is not an edit).
- **The file is read by the domain, from its bytes**: `examineReceipt` (pure) refuses a file that is empty or over 2 097 152 bytes (`422`
  `InvalidReceiptSize`), and one that does not start with `FF D8 FF` (JPEG) or the PNG signature (`422` `UnsupportedReceiptType`). It runs before the
  store, so a refused file is never sent to it. The type is never read from a header.
- **Who may attach** is the expense's rule, as for an edit (request 6), read through Ledger's read model of the expense and the owned port
  `GroupMembers`: a caller who is not a member of the expense's group gets the expense's `404`; a member who is neither its payer nor the group's
  owner gets `403`.
- **A store that keeps nothing refuses the receipt**, `422` `ReceiptNotKept`, with nothing changed. The status is `422` and not a `5xx` because
  request 1 allows no `5xx`.
- **Persistence**: `receipts` (`SqliteReceiptBook`, the port `IReceiptBook`): one row per receipt, unique per expense, with its version. `add` takes a new
  one, `save` a replaced one only at the version it was loaded at (ADR 8); a second receipt of an expense that another request attached first is a
  conflict, answered `409` after the command's retries, and the retry then replaces it. The row keeps no foreign key to the expense, so the deletion
  of an expense needs no change; a receipt of a deleted expense is never read, since the expense is not found first.
- **The route** `PUT /expenses/{id}/receipt` takes the body as bytes (`application/octet-stream`, parsed by its own content-type parser, limit 16 MB:
  a file over 2 MB but within it is refused by the domain with `422`; over 16 MB the transport answers `413`). `GET /expenses/{id}/receipt` answers the
  read model `{ type, size, url }`, or `404` when the expense has none.

## Consequences

- No new context, no new integration event, no change to the published language, and no change to the map: the events are domain events that nothing
  reacts to (`ReceiptAttached` has no policy, so `events: [ReceiptAttached]` in the storm is held by the code's aggregate alone).
- `api/26-receipts.yaml` is the fragment the routes answer. The API's shape is the one the fragment gives: `PUT` answers `2xx` (`204`), `GET` `200 { type, size, url }`.
- The file is sent to the store before the receipt is saved, so a failed save leaves a file in the store that no receipt names. A retry sends the file again,
  so a conflicting attach can leave an extra file there. Tally never deletes a file from the store (the API has no delete), so this is kept as it is.
- The storm `conventions/storms/receipts.yaml` is held to the code by `yarn architecture storm --expect`, and marked done when it owes nothing.
