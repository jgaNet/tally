# 9. Refund through the payment provider: the payee asks, and the balances go back when the provider says so

## Context

Request 15 lets the payee of a settlement paid through the provider (ADR 8) give the money back, whole. The storm
(`conventions/storms/refund-through-the-provider.yaml`, its hot spots) decided the shape before the run: a refund is a status
of the same settlement, not a settlement of its own; the balances go back when the provider says `refunded`, not when Tally
asks; a refund for a settlement whose payer or payee has left is refused (the book asks SettlementMembers, as request 9
does); and a `refunded` that overtakes the success of the same payment leaves the settlement refunded, never counted.

Two things the storm did not name were needed. First, Ledger counts a settlement while it is `refunding`: the money has not
gone back yet, so the balances still count it, and the effects Ledger reads (`SettledAmounts`) now take a set of statuses,
`paid` and `refunding`, instead of `paid` alone. Second, the provider's refund is a second call of the same port, so the
provider's refund endpoint is a second method of `IPaymentProvider`, not a new port.

## Decision

- **A refund is a status of the settlement.** `RefundSettlement` (signed in, `POST /v1/settlements/{id}/refund`, answered
  `202` with its operation) finds the book of the settlement's group, and `SettlementBook.proposeRefund` checks, in order:
  the caller is a member (or the settlement does not exist for them, `NotFound`); the caller is the payee (`NotThePayee`);
  the settlement was paid through the provider (`CashSettlementNotRefundable`); it is `paid` (`SettlementNotPaid`); and its
  payer and its payee are still members (`PayerNotAMember`, `PayeeNotAMember`).
- **The provider is asked before the book keeps the refund.** `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with
  `{ reference }` (the settlement's id), answered `201 { id }` within 5 seconds. Any other answer is `RefundUnavailable`, and
  nothing is kept. Once it accepts, `SettlementBook.keepRefund` makes the settlement `refunding` and records
  `RefundRequested`, and the book is saved with its version (CONC-OPTIMISTIC).
- **A refunding settlement is still counted.** Ledger reads `paid` and `refunding`; a suggestion still reads only `pending`
  as paid, and a refunding settlement is not pending, so the suggestions need no change.
- **The provider's word ends a refund, and the word follows the payment's order.** `refunded` makes a settlement refunded from
  `pending` (the refund that overtakes the success, which is never counted), from `paid`, and from `refunding`, recording
  `SettlementRefunded`. A `refunded` said twice counts once. A `succeeded` or `pending` after a refund changes nothing. A
  `failed` settlement is never refunded. The webhook handler is unchanged: it only saves what the book decided.

## Consequences

- One payment has one history, in one row: `pending`, `paid`, `refunding`, `refunded` (or `failed`). The book stays the one
  place a settlement is decided, so a refund and a cash settlement decided at once contend for the same version.
- The provider is called inside the command's transaction, as for a payment (ADR 8). A conflict on the book asks the
  provider again for the re-decided attempt; the provider's refund is then asked with the same reference (the settlement's
  id), which the provider is expected to treat as the same refund.
- A refund accepted by the provider but not yet reported by its webhook shows as `refunding` and is still counted. That is
  the storm's decision: the money has not gone back yet.
- A `refunded` that arrives for a settlement still `pending` publishes `SettlementRefunded` alone, not `SettlementPaid` first:
  the money was never counted, so there is no paid fact to undo.
- The `settlements` table's CHECK now names the two new statuses. A table an earlier version made keeps its old CHECK, so a
  database file from before this feature must be created again; there is still no migration (as ADR 8 says).

## When to revisit

When a refund must be partial (a settlement's amount is then no longer the whole of what was paid), or when the provider's
refund must be decided by Tally rather than by its webhook (a time the book would need, through the one clock), or when a
refund's outcome must reach another context as a fact (then a published `SettlementRefunded` integration event, against the
storm's decision that Ledger reads what is settled).
