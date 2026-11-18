# 19. Receipts: an aggregate in Ledger, kept in an outside store behind a port Ledger owns

## Context

Request 26: whoever may edit an expense (its payer, or the owner of its group) attaches a receipt to it, a JPEG or a PNG of
at most 2 MB, and a member of the group reads it: its type, its size and the link the store reads it at. Tally keeps no
files; the receipts are kept by an outside store, whose API is `RECEIPTS_URL`. The storm (`conventions/storms/receipts.yaml`)
decided the hot spots before the run.

## Decision

- **No new context and no new relationship.** The receipt is an aggregate in Ledger (`Domain/Receipt`), beside the expenses
  it belongs to. Ledger already asks Groups who is a member and with which role (GroupMembers, ADR 3), and the expense's rules
  are read through Ledger's own read model of the expense (`IExpenseQueries`), in a command's transaction through a variant
  that reads the connection the transaction holds (ADR 2).
- **The store is a port Ledger owns.** `IReceiptStore` (`Application/Ports`), named for what it decides: where a file is kept.
  Its adapter `HttpReceiptStore` calls `POST {RECEIPTS_URL}/files` with the file as the body and its type as `Content-Type`,
  answered `201 { id, url }`; anything else, an answer after 5 seconds, or no `RECEIPTS_URL` is `ReceiptStoreUnavailable`,
  and the receipt is refused. The store's answer is a plain value the Receipt takes; the aggregate refuses a link it cannot
  use, as it refuses any value it does not allow (DOMAIN-NON-DETERMINISM, as for the payment provider, ADR 8).
- **A receipt is its own aggregate, one per expense.** `Receipt` keeps its own identity (generated in `attach()`), its
  version, its file's type and size, the store's id and link. Attaching one to an expense that has one replaces it: the same
  receipt, at the version it was read at. The Expense is not touched, so it keeps its version (a receipt is not an edit).
  A row of `ledger_receipts` per expense, its `expense_id` unique: two attaches that race lose one, as a
  ConcurrencyConflict, and the command re-reads and re-decides (CONC-OPTIMISTIC).
- **The rules are the expense's, decided by the Receipt.** `Receipt.mayBeAttachedBy` refuses a caller who is neither the
  payer nor the owner (NotAllowedToAttachReceipt) and an expense that concerns a member who has left (FormerMemberInExpense),
  as an edit does. The command reads the expense, its role and the group's current members before it reads the file.
- **The type and the size are read from the bytes.** `ReceiptFile.read` takes the bytes as the transport handed them over: an
  empty file or one of more than 2 097 152 bytes is `InvalidReceiptSize`; a file whose first bytes are neither `FF D8 FF`
  nor `89 50 4E 47 0D 0A 1A 0A` is `UnsupportedReceiptType`. The header of the request is never read. Both refusals happen
  before the store is asked, so a refused file is never sent.
- **The transport keeps the body as it came, up to a limit of 16 MB** (`application/octet-stream`, a parser of its plugin),
  so that a file too large for the domain is refused by the domain behind the 202, as request 26 has it, and not by the
  transport. A body larger than 16 MB is refused by the transport's own limit (413).
- **The event.** Attaching records `ReceiptAttached` on the aggregate, published through the outbox after the commit like
  every domain event (EVENT-AFTER-COMMIT). No context subscribes to it yet; it is a domain event, not an integration event.

## Consequences

- A store that keeps a file and then fails the transaction leaves that file in the store, unreferenced. The attempt that lost
  a race asks the store again, so a conflict can leave an extra file behind. Neither is a refusal to the client; both are
  the cost of a store outside the transaction.
- The receipt's link is the store's; Tally does not check that it still answers. A reader follows the link as stored.
- An expense that is deleted keeps its receipt row, which no read reaches (the expense is gone from every read).

## When to revisit

When the store must be asked to remove files (an expense deleted, or a receipt replaced, as cleanup), or when a second
subscriber needs `ReceiptAttached`, which would make it an integration event in the published language.
