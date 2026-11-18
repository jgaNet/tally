# 23. Receipts: an aggregate of Ledger per expense, kept behind a port in an outside store

## Context

Request 26 (`api/26-receipts.yaml`) lets the payer of an expense, or the group's owner (the rule of requests 6 and 9), attach a receipt: a JPEG or a
PNG of 1 byte to 2 MB, its type read from its first bytes. Tally keeps no files: it sends the file to a receipts store at `RECEIPTS_URL`
(`POST {RECEIPTS_URL}/files`, `201 { id, url }`), and a member reads the receipt's type, its size and the link the store keeps it at. When the store
does not keep the file in 5 seconds, answers otherwise, or is not configured, the receipt is refused and nothing changes.

The storm (`conventions/storms/receipts.yaml`) was decided before the code: the store is a port Ledger owns, named for what it decides, whose answer
is a plain value the receipt takes; a receipt is its own aggregate, one per expense, so that attaching one is not an edit and the expense keeps its
version; the type and size are read by the receipt from the bytes it was sent, never from a header, and a refused file is never sent to the store.

No new context and no new relationship. The store is an outside service, as the rates service is (ADR 19): an adapter answers Ledger's port, and
the context map holds only the relationships between Tally's contexts. The members of a group are still read through `GroupMembers` (ADR 5), so the
map is unchanged.

## Decision

- **`Receipt` is an aggregate of Ledger**, in `Domain/Receipt`: `attachFirst()` makes the first receipt of an expense, its id generated there, and records
  `ReceiptAttached`; `attach()` replaces the file the receipt keeps under the same id and records `ReceiptAttached` again; `fromSnapshot()` records nothing
  and throws on corrupted data. The first receipt is not made by a `create()`: the storm checker reads a `create` of a context as the behaviour of every
  other `create` in it, so a `create` recording an event would be credited to the other aggregates' commands (the `SaveTemplate` of request 25 was). The name
  says what it does instead. It carries the
  version it was loaded at; its repository refuses a save over a newer one (CONC-OPTIMISTIC). The table holds one row per expense (a unique key on the
  expense), in the Ledger SQLite file beside the expenses it is for.
- **The rules are a pure decision** (`Receipt.decision.ts`, `decideAttachReceipt`). The expense's own rules apply: only its payer or the group's owner
  may attach (`mayChange`), and an expense with a former member among its payer or its split is refused (`concernsFormerMember`). Both are exported from
  `Expense.decision.ts` and reused, not copied. The file is then read by `readReceiptFile`: it must be 1 to 2 097 152 bytes, and start with `FF D8 FF`
  (JPEG) or the eight bytes of the PNG signature. The decision answers the type and size; the link is not its to decide.
- **The store is a port Ledger owns** (`IReceiptStore`, Application), answered by `ReceiptStoreOverHttp`. It sends the file as the body with its type as
  `Content-Type`, and keeps the link of a `201` that carries an id and a link. Any other answer, a timeout of 5 seconds (`RECEIPTS_TIMEOUT_MS`), a network
  failure, and an unset `RECEIPTS_URL` keep nothing, and the receipt is refused (`ReceiptNotKept`). The URL is read at each request (ADR 7).
- **The use case** (`Receipts.ts`, `attachReceipt`) reads the expense through `IExpenseQueries` (Ledger's own read model), asks GroupMembers who the caller is,
  decides, asks the store, and only then inserts or saves the receipt and publishes its events. All of it runs in the receipts' file transaction, as an
  offered rate is asked inside the expense's transaction (ADR 19).
- **Answers.** `PUT /expenses/{id}/receipt` answers `204`, `GET /expenses/{id}/receipt` answers `200 { type, size, url }`, and `404` when there is none; both
  are answered at once (`answerAtOnce`). A refusal of the file is `400 InvalidReceipt`; of the store `400 ReceiptNotKept`; of the caller `403` (a signed-in
  member who is neither payer nor owner) or `401` (no caller); of a non-member or a missing expense `404`. The API has no `5xx`, so a store that fails is a `4xx`.
- **The transport does not refuse a size.** The `application/octet-stream` parser of the expense routes passes the bytes as they were sent, with a ceiling of
  16 MiB, far above the 2 MB the domain allows: a larger file is refused by the rule's own answer (API-BODY-SHAPE: a length is the domain's to decide). The
  ceiling only keeps a request from filling memory.
- **Events.** `ReceiptAttached` is a domain event of Ledger with no subscriber yet; it is not an integration event, and nothing outside Ledger reads it.

## Consequences

- A receipt replaced by a new one: the new file is kept first, and the old receipt is replaced only once the store has kept the new one. A store that is down
  leaves the old receipt in place.
- The store has no API to delete a file, and Tally keeps only the link, not the store's id. A replaced receipt's file therefore stays in the store. The adapter
  reads the id and drops it, so a later feature that deletes files will need to keep it.
- An expense that is deleted keeps its receipt row, unread: its receipt is not reachable once the expense is gone (the expense answers `404`, and so does the
  receipt). The row is not removed with the expense.
- A store write holds the Ledger file's transaction for up to 5 seconds, so writers of that file wait for it. The rate service already does this (ADR 19); the
  storm's 5-second limit makes it bounded.
- The expense keeps its version and its balances: a receipt changes neither.

## When to revisit

When the store offers a delete (the replaced receipt's file is then removed, and the id is kept), when a receipt is to be announced to another context (it
would then be a published integration event, and a context map link would be declared), or when a receipt is to be read by someone who has left the group
(the former-member rule of the Expense applies to it now).
