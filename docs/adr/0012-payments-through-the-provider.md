# 12. A payment through the provider is pending in the SettlementBook, and counted once the provider says it succeeded

## Context

Request 13 lets a member who owes another member of the group pay them through the payment provider: Tally asks the provider
for a payment link, the payer pays there, and the provider's signed webhook says the payment succeeded or failed. The storm
(`conventions/storms/pay-through-the-provider.yaml`) decided five things before the code: the provider is behind a port
Settlements owns; the provider is asked after the rules are checked and before the book records the payment; anyone may send
the webhook, the signature being the proof; a pending payment counts as paid for what is still owed; and Ledger is not told
of a payment that succeeded, it reads what is settled when it reads a balance.

The feature brings no context and no relationship: the three links Settlements has (Ledger → Settlements, Groups → Settlements,
Settlements → Ledger) carry it, so the context map does not change. It brings three domain events, `PaymentRequested`,
`SettlementPaid` and `SettlementFailed`, recorded by the one aggregate Settlements has, as ADR 11 brought `SettlementRecorded`:
the events come in with the aggregate and nothing reacts to them, so none is an integration event. Two commands now reach
the `SettlementBook` besides the cash settlement, which the profile's several-writers trigger already holds (ADR 11).

## Decision

- **The provider is a port Settlements owns, `IPaymentProvider`** (`Application/IPaymentProvider.ts`), named for what it decides,
  a payment link for a reference and an amount. Its adapter, `PaymentProviderOverHttp`, posts `{ reference, amount, currency }` to
  `PROVIDER_URL` and takes `201 { id, payUrl }`, within 5 seconds. Any other answer, a timeout, a failure, or no `PROVIDER_URL`
  is no link, which the use case refuses as `ProviderUnavailable`, with nothing kept. The URL is read at each request (ADR 7).
- **The refusal is a `400`.** The API's answers are `2xx` and `4xx` only, and the transport answers any rule's refusal that is not
  a 404, 403 or 409 with `400`. A provider that cannot be reached is therefore a refusal of the request, not a server error.
- **The settlement's id is the provider's reference, and the decision generates it.** The rules of a payment through the provider
  are the cash settlement's, with the payer the caller (`refuseSettlement`, shared by both decisions), and the decision that allows
  it answers the settlement's values with a new id (`Id.generate()`, DOMAIN-IDENTITY), before the provider is asked.
- **The order of a payment is the order of a cash settlement.** The book is read, then the balances; the rules are decided on what is
  still owed; the provider is asked outside any write; then the book records the payment with the link in hand and is saved with its
  version checked (CONC-OPTIMISTIC). A payment another request made too much of moves the version, the save refuses this one, and the
  retry reads again and is decided on the balances with that payment counted. A retry asks the provider again, so an orphan payment
  can be left at the provider; no one holds its link, and a webhook about it changes nothing.
- **A payment waiting at the provider counts as paid for what is still owed.** `stillOwed` (`Domain/SettlementBook/StillOwed.ts`) moves
  the balances of the ledger by the waiting payments, as a cash settlement does; the rule, the cash settlement and the suggestions
  (request 11) decide on these. The ledger's balances, and the balances a member reads, count only the settlements that are paid:
  `settledOf` reads `status = 'paid'`, so a payment is counted once it is paid and not before.
- **The webhook is a command anyone may send** (`caller: 'anyone'`, said once in its definition). Its signature is the proof: the
  route reads the body as it was sent, checks `Provider-Signature` against the HMAC-SHA256 of those bytes under
  `PROVIDER_WEBHOOK_SECRET`, and refuses a missing or wrong one with `401` before anything is parsed or decided. Then the body's
  shape is checked (`400` for a field missing or of the wrong type). Any status is then acknowledged with a `2xx`.
- **A payment moves once, forward only.** `succeeded` settles a pending payment to paid, `failed` to failed; a payment that is not
  waiting (already settled, or never known to Tally) and a status that is not one of those change nothing. So a webhook counted once
  is counted whatever the provider sends again, and it is answered `2xx` each time so the provider stops sending it.
- **The settlements' table gains two columns**, `provider_payment_id` and `pay_url`, added to a database request 12 made by a
  guarded `ALTER TABLE` before anything reads them.
- **The API** is `api/13-pay-through-the-provider.yaml`: the settlement gains the provider's method, its pending and failed statuses,
  and the `payUrl` a payment through the provider has.

## Consequences

- A payer gets the link only once the request has committed, so the provider cannot send a webhook about a payment Tally has not
  stored, unless a retry left an orphan payment nobody holds. A webhook about a payment Tally does not know changes nothing, as the
  request says.
- Leaving a group (request 9) still reads the paid balances, and needs them at 0. A member with a waiting payment owes or is owed
  at least its amount in those balances, so they cannot leave while it waits, and no change to leaving is needed.
- An expense recorded while a payment waits may change what the payer still owes, so a waiting payment can then be more than is
  owed. This is the same accepted consequence as ADR 11's for expenses: the book's version does not move for an expense.
- The suggestions read the paid balances and the waiting payments in two statements. Each pair is zero-sum, so the suggestions always
  add up, though a suggestion read during a webhook may see a payment once or not at all for an instant.

## When to revisit

When a reminder or a refund is decided: a reminder (request 16) asks what a member still owes, so it uses `stillOwed` through the same
port; a refund (request 20 onwards) moves a paid payment back and needs its own status. And if the provider's webhooks are ever
needed by another context, the paid payment becomes an integration event, with the balances' reads moved to it, as ADR 11 says of
Ledger's reads.
