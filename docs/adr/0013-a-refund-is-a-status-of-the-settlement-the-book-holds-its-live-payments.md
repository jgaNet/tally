# 13. A refund is a status of the settlement, and the SettlementBook holds the payments that are still live

## Context

Request 15 lets the payee of a settlement paid through the provider give the money back, whole. Tally asks the provider to refund
the payment; the money has not gone back yet, so the settlement is `refunding` and the balances still count it; when the
provider's webhook says `refunded`, the settlement is refunded and the balances no longer count it, as they were before it was paid.
The storm (`conventions/storms/refund-through-the-provider.yaml`) decided four things before the code: a refund is a status of the same
settlement and not a settlement of its own; the balances go back when the provider says so, not when Tally asks; a refund is refused
when the payer or the payee has left the group (request 9); and a `refunded` that overtakes the `succeeded` of the same payment leaves
the settlement refunded and never counted.

The feature brings no context and no relationship: Settlements, the links to Groups (`SettlementMembers`) and to Ledger
(`SettledAmounts`) carry it, so the context map does not change. It brings two domain events, `RefundRequested` and
`SettlementRefunded`, recorded by the one aggregate Settlements has, and nothing reacts to them, so neither is an integration event.

Two things in the code change. A refund needs the provider's id of a paid payment, and the book (ADR 11, ADR 12) held only the
payments waiting at the provider. And the balances read only the settlements that are paid (ADR 12), which would stop counting a
settlement that is being refunded before the provider has returned the money.

## Decision

- **A refund is a status, `refunding` then `refunded`, of the settlement it refunds.** One payment keeps one history and one effect.
  `SettlementStatus` gains the two values; `SettlementView` and the API say so (`api/15-refund-through-the-provider.yaml`).
- **The book holds every live payment through the provider**: the ones waiting (`pending`), the paid ones and the ones being refunded.
  A payment that failed or was refunded is no longer held. `ProviderPayment` carries the provider's id for it, which a refund is asked
  with. `SettlementBook.requestRefund` moves a paid one to `refunding` and records `RefundRequested`; `settlePayment` moves a pending one
  to paid or failed, or any live one to refunded, and records `SettlementPaid`, `SettlementFailed` or `SettlementRefunded`.
- **Forward only.** `succeeded` moves only a pending payment; `refunded` moves a pending, paid or refunding one, so a refunded that
  overtakes the success ends refunded and is never counted. A payment already refunded is no longer held, so a second `refunded`, or a
  `succeeded` after it, changes nothing: a webhook counts once, as ADR 12 says.
- **The balances count the settlements being refunded.** `settledOf` reads `paid` and `refunding`, since the money has not gone back yet
  (request 15); `refunded` is not counted. `pendingOf` and the balances of what is still owed are unchanged.
- **The book is read before the settlement and the members.** `RefundSettlement` finds the book of the settlement's group by its id
  (`bookOfSettlement`, whatever the settlement's status), then reads the settlement and the members of the group. A change to the
  settlement after the book was read moves the book's version, so the save refuses the decision and the retry reads again (CONC-OPTIMISTIC,
  as ADR 11 says of the cash settlement).
- **The decision is pure** (`decideRefundSettlement`): only the payee may (`403`, a signed-in caller the rule refuses, `404` for a caller
  who is not a member); the settlement must be a provider one (`400`), `paid` (`400`), and both its payer and its payee must still be
  members (`400`, request 9).
- **The provider is asked outside the write**, as the provider is asked for a payment link (ADR 12): `IPaymentProvider.refundPayment`,
  answered by `PaymentProviderOverHttp` as `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, accepted only with a
  `201 { id }` within 5 seconds. Any other answer, a timeout, or no URL is a refusal (`400`, `ProviderRefundUnavailable`) with nothing
  changed.
- **The API** is `POST /v1/settlements/{id}/refund`, answered at once with `204`. The webhook's `refunded` is acknowledged with a `2xx`
  like any signed webhook.

## Consequences

- A refund accepted by the provider and then not saved (a retry that finds the book moved, for instance) leaves the provider's refund
  made while Tally still shows the settlement paid until the provider's `refunded` webhook arrives, which the book then handles as usual.
  A retry asks the provider again, and it is the provider's to refuse a refund it already made; if it does not, the cost is one period in
  which the provider and Tally disagree, which the webhook settles.
- A payment is refunded whole only. A partial refund is not in the request, and the rules of the balances do not allow for one.
- The balances of a group with a settlement being refunded still count it, so leaving the group (request 9) needs them at 0 as before; a
  refund is refused for a payer who has left, so the balances of a group still add up to 0 in every read (each settlement moves two
  balances by the same amount, in one transaction).

## When to revisit

When a refund must be partial, or a payment is refunded more than once at the provider: the book would then hold the amount refunded so
far, and `requestRefund` would take an amount. And when the provider's refund outcome is needed by another context, a refunded payment
becomes an integration event, as ADR 11 and ADR 12 say of the payment.
