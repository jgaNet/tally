# 14. A settlement through the provider is pending in the group's book, and counted once its payment succeeds

## Context

Request 13 lets a member pay what it owes by card, through the payment provider: `POST /groups/{id}/settlements/provider { to, amount }`
asks the provider for a payment link, answered `201 { id }` with the caller as payer, and the provider's signed webhook
`POST /provider/webhooks { id, paymentId, status, at }` says when the payment `succeeded` or `failed`. A settlement through the provider is
`pending` until then; a payment waiting at the provider counts as if it were paid for what is still owed (the rule, the suggestions), and
the balances count it only once it is paid.

The storm (`conventions/storms/pay-through-the-provider.yaml`, decided with the product's owner) named the provider as a port Settlements
owns, the order of the asking and the deciding, who may send a webhook, what a pending payment changes, and that a payment that succeeded
is not told to Ledger as an event. ADR 0013 named this request as the one where the book's status moves and the balances must count a
pending payment.

## Decision

- **The provider is an outside system, not a context, behind a port Settlements owns.** `IPaymentProvider` (`Application/Ports`) asks for a
  payment link for a reference (the settlement's id), an amount and the group's currency; its answer is a plain value, a link or the refusal
  `ProviderUnavailable`. The adapter (`HttpPaymentProvider`) calls `PROVIDER_URL` with a 5-second limit and reads the base from the environment
  when it is used: without it, every payment is refused and nothing is kept. No context and no relationship between contexts is new: the three
  links the storm names are carried already, so the context map is unchanged.
- **The book decides before the provider is asked, and again with the link in hand.** `reserveProviderPayment()` checks the rules and
  reserves the settlement's id, which is the provider's reference, and records nothing. The provider is then asked. `recordProviderPayment()`
  decides again and records the settlement `pending`, with its `payUrl` and the provider's payment id, as `PaymentRequested`. A refused settlement
  asks the provider for nothing more, and a provider that gives no link keeps nothing: the transaction holds nothing. A retry after a conflict
  may ask the provider again, so a payment it made for a settlement that was never kept is an orphan: nothing names it, so it is never paid.
- **Pending counts as paid for what is still owed, by one rule.** `stillBalance()` moves a member's balance by what it is waiting on, on the side
  it is waiting on, never past 0: what a member still owes is its debt less what it is waiting to pay; what it is still owed is its credit less
  what is waiting to be paid to it. The book applies it to the rule (`recordCash`, `reserveProviderPayment`) and the suggestions apply it to every
  balance, so a suggestion never asks for a transfer already on its way.
- **The balances count only what is paid.** `settledOf` (what Ledger reads, docs/adr/0013) counts settlements with status `paid`: a pending or a
  failed one is not in any balance. The waiting amounts are read in one statement by `waitingOf` for the suggestions.
- **The book holds the pending settlements of its group,** loaded with its version (`fromSnapshot({ pending })`), so the webhook moves their
  status in the book it saves against the book's version (CONC-OPTIMISTIC). `ofPayment()` finds the book from the provider's payment id; a payment
  Tally does not know has no book, and changes nothing.
- **The webhook is anyone's to send, and signed.** The use case says `{ caller: 'anyone' }` once. Its signature is checked first, over the body
  as sent (this plugin's JSON parser keeps the text beside its parsed body), with HMAC-SHA256 and `PROVIDER_WEBHOOK_SECRET`, compared in constant
  time; a missing or wrong one is `NotAllowedException`, answered `401` to a request with no caller. Everything else is acknowledged: a payment
  that succeeded or failed, once, makes its settlement paid or failed (`SettlementPaid`, `SettlementFailed`); `pending`, an unknown status, a
  payment already ended and a payment Tally does not know change nothing and answer `204`.
- **The events are domain events, not integration events.** `PaymentRequested`, `SettlementPaid` and `SettlementFailed` are the book's, published
  after its commit with the outbox, as the storm names them. No other context reacts to them, so none is told: Ledger reads what is paid when it
  reads a balance (the storm's decision).
- **A refusal of the provider is `422`,** the default for a refusal that is not a rule's `4xx` in the transport, since the API never answers `5xx`
  (`ProviderUnavailable`). The building blocks are unchanged.
- **`SettlementMembers` answers the group** (`groupOf`): its current members in the order they joined, and its currency, which the provider needs.
  The Groups → Settlements link carries the same contract, read over Groups' read model; no relationship is added.
- **`payUrl` is on a settlement through the provider only,** and a cash settlement has none, as request 13's fragment says.

## Consequences

- A payment that never ends (no webhook) keeps what it was waiting on: the debt stays as if paid, and the settlement stays `pending`. Tally does not
  time a payment out; that is a decision for a later request.
- A payment the provider made after a conflict is orphaned: it is never counted, and its webhook changes nothing.
- The store adds two columns to the settlements table (`pay_url`, `provider_payment_id`) and a unique index on the payment id; a file made before
  this request is migrated when it is opened.
- The HTTP adapter and the signature read their configuration at each use, so the environment set after the application starts is used.

## When to revisit

At request 14 (a refund), where a paid settlement can be undone and what it counted with it, and with it a pending payment's timeout if the product
asks for one.
