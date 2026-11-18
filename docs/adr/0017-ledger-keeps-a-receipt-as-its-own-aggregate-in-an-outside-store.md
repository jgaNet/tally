# 17. Ledger keeps a receipt as its own aggregate, its file in an outside receipts store behind a port (no new context, no new relationship)

## Context

Request 26 has a member attach a receipt to an expense: a JPEG or a PNG of at most 2 MB, sent as the body of the request, and read
back as its type, its size and the link the store keeps it at. Tally keeps no files; the file goes to a receipts store, an outside
system with an API of its own (`POST {RECEIPTS_URL}/files`, answered `201 { id, url }`). The storm `receipts` decided three hot spots
with the product's owner: where the store sits in the model, whether the receipt is part of the expense, and who reads the file's
type and size. This ADR records what the storm left to the code. It follows ADR 13, which put the rates service behind a port the
same way.

## Decision

- **The store is behind a port Ledger owns, in its Application layer** (`IReceiptStore`, `Ledger/Application/Ports`), named for what it
  decides: where a file is kept. Its answer is a plain value, the link (`KeptReceipt`), or null when the store kept nothing: it
  answered something else, did not answer within 5 seconds, or `RECEIPTS_URL` is not set. The adapter `HttpReceiptStore` reads
  `RECEIPTS_URL` when a file is kept, the way the rates adapter reads `RATES_URL` (ADR 13).
- **A receipt is its own aggregate** (`Receipt`), beside `Expense`, not a field of it. An expense has at most one: its table has one row
  per expense (UNIQUE), and attaching another replaces that row's file, link and attacher, at the version it was read at, under the same
  id. A receipt is not an edit, so the expense keeps its version and its events are not recorded again.
- **The file is judged before anything is sent, and the store's link is taken after.** The handler reads the file (`readReceipt`: its
  type from its first bytes, never from a header; its size; empty, larger than 2 MB, or neither a JPEG nor a PNG is refused), reads the
  expense through Ledger's read model, and asks `Receipt.mayAttach`, the expense's rule: the payer or the group's owner, and no former
  member among the expense's members (ExpenseOfFormerMember, as an expense may not change once a member has left). Only then is the
  store asked; `Receipt.attach` takes the link it kept, refuses an empty one, and records `ReceiptAttached`. A refusal at any step changes
  nothing and leaves the file out of the store.
- **`ReceiptAttached` is a domain event, not an integration event.** No other context reads a receipt; the event is published with the
  state it describes, in the transaction, and handled by no one.
- **The transport's ceiling is 16 MB, and the domain's limit is 2 MB.** The route accepts `application/octet-stream` bodies up to 16 MB
  so that a larger file reaches the domain and is refused as `InvalidReceipt` (400), rather than refused by size at the transport.

## Consequences

- No new context and no new relationship in the context map. The store is an outside system, declared as the rates service and the
  payment provider are; the Groups → Ledger link already carries `GroupMembers`. `domain.yaml` gains one term, `Receipt`, in Ledger's
  language.
- The command's base class retries a conflict by running the handler again (ADR 25), so a second attach racing a first can store its file
  twice: the file of the attach that lost is left in the store, unreferenced. The storm does not ask for cleanup, and the API does not
  show it; the orphan is accepted and recorded here.
- The store's own id is not kept: the API answers the link only, so nothing reads the id back. The receipt's identity is Tally's, generated
  by the domain (DOMAIN-IDENTITY).
- A refusal of the store is answered as a 400 with `ReceiptNotKept`, not a 5xx: the API's answers are 2xx or 4xx only.

## When to revisit

When a replaced or removed receipt's file must be deleted from the store (then the store's id is kept with the receipt, and the
replacement asks the store to remove the old file); when another context needs to know of a receipt (then it becomes an integration
event, declared in the published language); or when a receipt must be read by a member who left the group.
