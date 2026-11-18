# 17. A receipt is an aggregate of Ledger, kept in an outside store behind a port Ledger owns

## Context

Request 26 lets the payer of an expense, or the group's owner, attach a receipt to it: a JPEG or a PNG of 1 byte to 2 MB, whose type is read
from its first bytes. Tally keeps no files: the receipt is kept in a receipts store with an API of its own, which the server is started with
(`RECEIPTS_URL`). A member of the group reads the receipt's type, size and the link the store reads it at. The storm
(`conventions/storms/receipts.yaml`) decided three hot spots: where the store is in the model, whether the receipt is part of the expense, and
who reads the file's type and size.

The storm needs no new context and no new relationship. The receipts belong to the expenses, so they are Ledger's; who may attach one is the
expense's own rule (its payer or the group's owner, and no former member), which Ledger already decides, and who the members are is read from
Groups through `GroupMembers`, the port Ledger already owns (ADR 3). The store is not a context: it is an outside service Tally calls, as the
rates service is (ADR 13), so the context map is as it was.

## Decision

- **The store is a port Ledger owns, `IReceiptStore`, in its Application layer.** It is named for what it decides: where a file is kept. Its
  answer is a plain value, the file's id there and the link it is read at (`StoredReceipt`), which the receipt takes, and `null` when the store
  kept nothing. The adapter, `HttpReceiptStore`, calls `POST {RECEIPTS_URL}/files` with the file as the body and its type as `Content-Type`, and
  keeps the file only on `201 { id, url }`, within 5 seconds. `RECEIPTS_URL` is read when a file is kept, so a server started without it refuses
  every receipt and changes nothing else (`ReceiptNotStored`).
- **A receipt is its own aggregate, `Receipt`, one per expense.** It is not part of the expense: attaching one is not an edit, so the expense keeps
  its version and nothing of the expense changes. A receipt attached replaces the one the expense had: the same receipt, its id kept, at its
  version + 1 when saved. The table's key is the expense, so an expense has at most one receipt at the database too.
- **Who may attach is decided by the receipt, from the expense's facts.** The handler reads the expense through Ledger's own read model,
  read inside its transaction (`IExpenseFacts`, which takes no lock: the exclusive read of a query would wait for the transaction it runs in), and its role in the group through `GroupMembers`, and passes them to `Receipt.attachable`: the caller is the payer or the
  owner, and the payer and every member of the expense's split are still members of the group (`NotThePayerOrTheOwner`,
  `ExpenseConcernsAFormerMember`, the same refusals as an edit). For anyone who is not a member the expense does not exist (`NotFound`).
- **The file's type and size are read from the bytes the transport hands over, as they were sent.** `ReceiptFile.inspect` decides the type from the
  first bytes (`FF D8 FF` for a JPEG, the eight PNG bytes for a PNG) and the size from the length, which must be from 1 to 2 097 152 bytes; any
  other file is refused as `InvalidReceiptFile` behind the 202. The transport accepts a body up to 16 MB for this route, so that a file of 2 MB or
  more is refused by the receipt, as the rule says, and not by the transport.
- **Nothing is sent to the store before the file and the rule are right.** The handler checks the file and asks `Receipt.attachable` first, and
  only then calls the store; a store that keeps nothing refuses the attachment (`ReceiptNotStored`) and the receipt the expense had is kept.
- **Reading it.** `GET /v1/expenses/{id}/receipt` answers the receipt's type, size and link to a current member of the expense's group. For anyone
  else, or for an expense that does not exist, or one with no receipt, it is `404`.

## Consequences

- The store is called inside the attachment's transaction, as the other outside services are called from a command. A store call that succeeds
  before the transaction is rolled back (a concurrent change of the same receipt, retried by the command handler) leaves a file in the store that
  no receipt names; the store is not asked to remove it. The file is never read by Tally again except through the link of the receipt kept.
- A deleted expense keeps its receipt in the table, which its reads no longer reach: the expense is not found, so the receipt is not either.
  Nothing removes the receipt or its file when an expense is deleted; this request does not say so.

## When to revisit

If receipts should be kept in another group's currency, or be read by people who are not members, the reads change where they are decided. If
the store should be asked to remove replaced files, the receipt's replacement is where that call belongs, after the commit, as an outbox event.
