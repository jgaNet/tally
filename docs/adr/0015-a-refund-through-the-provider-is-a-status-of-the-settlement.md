# 15. A refund through the provider is a status of the settlement, counted until the provider says it went back

## Context

Request 13 pays a settlement through the provider and request 14 moves its payment forward: a settlement is `pending`, then `paid` or `failed`,
and the webhook says which. Request 15 lets the payee of a settlement paid through the provider refund it, whole: `POST /settlements/{id}/refund`
asks the provider to refund the payment, `POST /provider/webhooks` says `refunded` when it has, and a settlement can be `refunding` or `refunded`
in between and after.

The storm (`conventions/storms/refund-through-the-provider.yaml`, decided with the product's owner) decided four things: a refund is a status of the
same settlement, not a settlement of its own; the balances go back when the provider says `refunded`, not when Tally asks; a settlement whose
payer or payee has left is not refunded; and a `refunded` that overtakes the success of the same payment leaves the settlement `refunded`, never
counted. ADR 0014 named this request as the one where a paid settlement can be undone.

## Decision

- **A refund is a status of the settlement, and the settlement is refunded only through the provider.** `refunding` and `refunded` are statuses of
  the same row: one payment has one history. A cash settlement has no refund in Tally (it is refused, `422 SettlementNotRefundable`).
- **The book decides, and asks the provider after it.** `RefundSettlement` reads the settlement, its group and the caller's membership (a settlement
  the caller may not see does not exist: `404`). The book decides with `reserveRefund()`: the settlement is a paid one through the provider that the
  book holds, the caller is its payee (`403 NotAllowed` for another member), and its payer and payee are still members of the group, so that the
  balances still add up to 0 (`SettlementNotRefundable`). The provider is then asked, `POST {PROVIDER_URL}/payments/{paymentId}/refunds { reference }`
  with the settlement's id as the reference. Any answer other than `201 { id }`, or no answer in 5 seconds, is `ProviderUnavailable`, and nothing
  changes. The book then records `recordRefund()`: the settlement is `refunding` and `RefundRequested` is published after the commit.
- **Until the provider says it went back, the settlement still counts.** `refunding` is counted by the balances (`settledOf` reads `paid` and
  `refunding`), so the money is still with the payee in the balances. `refunded` is not counted: the balances are as they were before the payment.
- **The provider's `refunded` moves a settlement once, from wherever it is.** The webhook moves a pending, a paid or a refunding settlement to
  `refunded` (`SettlementRefunded`). A `refunded` said twice counts once; a `succeeded` or a `pending` that comes after it changes nothing; a `refunded`
  that overtakes the `succeeded` leaves the settlement `refunded`, never counted. The forward-only rule of request 14 holds, with `refunded` last.
- **The book holds the provider's settlements that are not ended.** Beside the pending ones it holds the paid ones and the refunding ones of its group,
  loaded with its version, so a webhook and a refund move them in the book they save against the book's version (CONC-OPTIMISTIC). A refund is decided
  before the provider is asked and recorded after it, as the payment is (ADR 0014).
- **No context and no relationship is new.** The members come over the Groups → Settlements link (`SettlementMembers`), the settlement's group and the
  balances over the links already in the map. `IPaymentProvider` gains one method, in the same port the payment uses.

## Consequences

- A refund asked of the provider and then refused by the book's save (a webhook moved the book first) is answered `422`, though the provider has refunded
  the payment; the webhook's `refunded` has already made the settlement `refunded`, which is the state the request asked for. A retry after a conflict
  asks the provider again, as a retry does for a payment (ADR 0014): the provider's refund is named by the settlement's reference, so the provider can
  refuse a second one.
- A refund the provider never confirms (no webhook) keeps the settlement `refunding`, counted as paid. Tally does not time a refund out.
- The store's status update names a settlement by its id only: the book's version already guarantees that the rows it moves are the ones it read.
- `SettlementStatus` gains `refunding` and `refunded`; no other route changes its answer.

## When to revisit

When the product asks for a partial refund, a refund by the payer, or a refund that times out at the provider.
