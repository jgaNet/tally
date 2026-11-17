# 8. Pay through the payment provider: a payment waits, is still owed, and ends once

## Context

Request 13 lets a member who owes another pay by card, through a payment provider, an outside system with an API of its own.
Tally asks it for a payment link (`POST {PROVIDER_URL}/payments`), the payer pays there, and the provider tells Tally, by a
signed webhook, that the payment succeeded or failed. The storm (`conventions/storms/pay-through-the-provider.yaml`, its
hot spots) decided the shape before the run: the provider is a port Settlements owns; the provider is asked before the
book records and the book decides again with the link in hand; anyone may send the webhook, and the signature is the proof;
a pending payment counts as paid for what is still owed, and the balances count it only once paid; and Ledger reads what was
settled when it reads a balance, not a copy of it.

Two things the storm did not name were needed. The provider is asked in the group's currency, which only Groups knows: the
relationship Groups → Settlements carried `SettlementMembers` only, so it now carries a second contract, `GroupCurrency`. And
a member's payment through the provider is refused unless the payee is a member too, so the book checks the payee's
membership as well as the payer's.

## Decision

- **The provider is a port Settlements owns** (`IPaymentProvider`, in its Application layer), named for what it decides:
  a payment link for a reference (the settlement's id), an amount and a currency. Its adapter, `HttpPaymentProvider`, calls
  `PROVIDER_URL` with a 5-second limit. Any other answer, a timeout, and no `PROVIDER_URL` at all are the refusal
  `ProviderUnavailable`, and nothing is kept.
- **The currency is a second contract from Groups** (`GroupCurrency`, `IGroupCurrency` in Settlements' Domain, answered over
  Groups' read side as `groupCurrencyInCommand`). The link Groups → Settlements carries it, and `conventions/domain.yaml`
  says why. Settlements still never reaches into Groups' application or infrastructure (ADR 3).
- **The book decides twice** (`SettlementBook`, one per group, ADR 7). `proposePayment` checks the rules on the balances and
  the waiting payments the command read in its transaction, and makes the settlement's id; the provider is asked with that id;
  `keepPayment` decides again with the link in hand, and keeps the settlement pending with its `payUrl`, recording
  `PaymentRequested`. A payment that two requests make at once is refused by the same rule as in cash, through the book's
  version (CONC-OPTIMISTIC), and a conflict asks the provider again for the re-decided attempt. An orphan payment the provider
  made for a lost attempt is never paid, since no settlement holds it, and a webhook for it changes nothing.
- **A pending payment counts as paid for what is still owed, and only then.** The book adds its pending settlements to the
  balances it is given, for the rule, and the suggestions (`GetSuggestedSettlements`) add the pending effects read through
  `IWaitingEffects`. The balances Ledger reads (`SettledAmounts`) count only settlements with status `paid`
  (`SqliteSettlementEffects`, now with its status). A pending payment therefore moves nothing in a balance.
- **The webhook is signed, checked before anything is decided.** The provider's `Provider-Signature` is the HMAC-SHA256 of the
  body as sent, with `PROVIDER_WEBHOOK_SECRET` as the key, in lowercase hexadecimal; a missing, wrong, or unconfigured one is
  `401`, and the command is not published. The route's JSON parser keeps the raw bytes (scoped to Settlements' routes), and a
  signed body is acknowledged whatever it says. The handler says once that anyone may ask (`anyoneMayAsk`).
- **The webhook decides from the book that holds the payment.** `ReceivePaymentWebhook` finds the book of the group that holds
  the provider's payment id, and changes a pending settlement to `paid` on `succeeded` (recording `SettlementPaid`) or to
  `failed` on `failed` (recording `SettlementFailed`). A payment Tally does not know, a `pending` word, or a payment that has
  already ended changes nothing.
- **Ledger is not told as a fact.** As the storm decided, Ledger reads what is settled when it reads a balance; no integration
  event crosses from Settlements to Ledger.

## Consequences

- A payment through the provider is in the same book as a cash settlement: they contend for the same version, so a cash
  settlement and a provider payment decided at once cannot together pay more than is owed.
- The provider is called inside the command's transaction, so a slow provider holds the group's book for up to 5 seconds. The
  storm chose this, so that a refused link is never kept.
- A webhook that races a settlement's own update conflicts on the book's version and is decided again by the command.
- The `settlements` table is created with the statuses and the two columns (`provider_payment_id`, `pay_url`) that this
  decision needs. `CREATE TABLE IF NOT EXISTS` does not change a table an earlier version made, so a database file from
  before this feature must be created again; there is no migration yet.

## When to revisit

When the provider's webhooks must carry a refund or a dispute (a status Tally does not yet know), or when a payment's
expiry must be decided by Tally rather than by the provider (a time the book would need, through the one clock), or when
a settlement's status must reach another context as a fact (then a published `SettlementPaid` integration event and a
Ledger that keeps its own copy, against the storm's decision).
