# 8. A payment through the provider is pending until the provider says how it ended, and only then counted

## Context

Feature 13 (pay through the payment provider) is the first settlement that waits on an outside system. A member asks to pay
another member through the provider; Tally asks the provider for a payment link; the payer pays there; the provider's signed
webhook says the payment succeeded or failed, possibly late, twice or out of order. The storm
(`conventions/storms/pay-through-the-provider.yaml`) decided five hot spots: where the provider sits in the model, when it is
asked, who may send the webhook, what a pending payment changes, and whether Ledger hears of a payment as a fact.

ADR 7 left one question open: when a settlement can be pending, does `settledOf` count it? It said the balances would count a
pending payment as paid, if the storm said so, and that the status could move into the query if not.

## Decision

- **No new context, no new relationship.** The provider is an outside system, not a context, so `conventions/domain.yaml` is
  unchanged and the context map still carries the three links ADR 6 and ADR 7 declared. The provider is a port Settlements owns in
  its Application layer, `IPaymentProvider` (a payment link for a reference, an amount and a currency), answered by an adapter
  over the provider's HTTP API (`HttpPaymentProvider`, `PROVIDER_URL`, 5 seconds). Its answer is a plain value: a link, or `null`
  for anything the provider did not answer as its API says, a timeout, or no URL configured. `null` is refused as
  `ProviderUnavailable`, and nothing is kept.
- **The group's currency comes through the port that already carries the members.** Settlements' `ISettlementMembers`
  (`SettlementMembers`, the link Groups → Settlements) gains `currencyOf`; Groups' read model gains the same method. The contract
  is the same contract, read from the same read model.
- **"What is still owed" counts what is waiting, and the balances do not.** Two readings, one per question the code answers:
  - The rule of a settlement (cash or through the provider) and the suggestions count a payment waiting at the provider as paid.
    The `SettlementBook` holds the group's pending settlements, read with the book, and adds their effect to the balances Ledger
    gives it (`waitingEffectOn`). The suggestions read the same effect from Settlements' own table (`IPendingPayments`).
  - The balances count a payment once it is paid. Ledger's `settledOf` reads the paid settlements only, so a pending payment is
    not in any balance, not in leaving, and not in a statement. This settles the open question of ADR 7: the status is filtered in
    Settlements' query, not moved into Ledger.
- **Decided twice, the second time with the link in hand.** `PayThroughProviderCommandHandler` plans the payment first (the rules,
  and the id the provider is given as its reference), so a refused payment never reaches the provider; asks the provider; then
  records the payment with the link, deciding again on the balances read after the provider answered. Both happen in the command's
  transaction, so two payments requested at once are decided one after the other, and the version check (CONC-OPTIMISTIC) makes the
  second re-read the first.
- **The webhook is anyone's to send, and the signature is the proof.** `ReceivePaymentWebhookCommandHandler` says `anyoneMayAsk`
  once. The transport checks the signature in `preValidation`, over the body as it was sent (the JSON parser keeps the raw body,
  `FastifyApplication`), before the body is validated or anything is published: a missing or wrong signature is `401`, and
  nothing changes. The webhook changes a settlement only when its payment is known and waiting, and the provider says `succeeded`
  or `failed`; any other webhook is acknowledged and changes nothing. A status change is a change of the book, so it bumps the
  version, and a decision in progress against the old status is re-decided.
- **Events.** A payment requested records `PaymentRequested`; the webhook records `SettlementPaid` or `SettlementFailed`. Each is
  made durable with the book in its transaction and published after the commit, as the cash settlement's is. None is an
  integration event: Ledger reads what is paid when it reads a balance (ADR 7), so no copy of a payment is sent to it.

## Consequences

- The provider is called while the command's transaction is open, so the file's write lock is held for up to the provider's 5
  seconds. At the scale the requests describe that is acceptable, and it keeps the second decision in the same transaction as
  the first; a call made outside the transaction would need a state for a payment the provider has accepted but Tally has not
  kept.
- A payment the provider created but Tally did not keep (the second decision refused, or the commit failed after the link came
  back) is an orphan at the provider: its webhook names a payment Tally does not know, so nothing changes. The second decision
  runs under the same lock as the commit, so the refusal it can make is only one a concurrent payment would have caused, which
  the lock prevents.
- The webhook's `2xx` is the operation's `202`, read at `/v1/operations/{id}`. The provider needs only the `2xx`.
- The settlements table gains two nullable columns (`provider_payment_id`, unique, and `pay_url`). The application keeps no
  migrations, so a database file created before this feature must be recreated.

## When to revisit

- When the provider's calls are slow enough that holding the file's lock for them matters, the call moves out of the transaction,
  and the payment gets a state for "asked, link not yet kept".
- When refunds or other provider statuses arrive, `SettlementBook.receivePayment` is where they are decided.
