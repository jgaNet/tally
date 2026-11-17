# 16. A payout account is an aggregate of Settlements, known to the provider, and required to be paid through it

## Context

Request 16 lets a signed-in person say which account at the payment provider it is paid on: `PUT /v1/accounts/me/payout-account { accountId }`
sets it, once the provider knows it, and `GET /v1/accounts/me/payout-account` reads it back, its owner alone. From then on a member is paid
through the provider only with a payout account: asking to pay someone who has none is refused by the name of that rule, before the provider is
asked, and the provider is told the payee's account in `POST /payments`.

The storm (`conventions/storms/payout-accounts.yaml`, decided with the product's owner) named where the account lives (Settlements, as an
aggregate of its own per person), who knows whether the provider knows it (the provider, through a port Settlements owns), and where "required
to be paid" is decided (the settlement book, when a payment is asked for). The domain map already names `PayoutAccount` in Settlements'
language, and no relationship between two contexts is new: the account is read by the same context that pays through it.

## Decision

- **The payout account is an aggregate of Settlements, one per person.** `PayoutAccount` (`Domain/PayoutAccount`) holds the provider's id of
  the account a person is paid on. Its identity is the person's account id, born with the account and taken up as it is (DOMAIN-IDENTITY),
  as a settlement book's is its group's. Its version is what a save checks (CONC-OPTIMISTIC). A person with none is at version 0.
- **The provider answers whether it knows the account, and the aggregate decides.** `IPaymentProvider.findPayoutAccount()` asks
  `GET {PROVIDER_URL}/accounts/{id}`: `200 { id }` is the id it knows the account by, `404` is "it does not know it" (the answer `undefined`),
  and anything else, or no answer within 5 seconds, is the refusal `ProviderUnavailable`. `PayoutAccount.set()` takes that answer as a plain
  value and refuses an account the provider does not know, or one it answers with another id (`UnknownPayoutAccount`); a refused account changes
  nothing. `SetPayoutAccount` reads the account first, asks the provider, decides, saves against the version and publishes `PayoutAccountSet`.
- **Required to be paid is decided by the book, from the payee's account.** `PayThroughProvider` reads the payee's
  `PayoutAccount` through its repository, and passes the provider's id of it to `SettlementBook.reserveProviderPayment()` (and again to
  `recordProviderPayment()`). A payee with none is refused by the name `PayeeHasNoPayoutAccount` after the rules every settlement has, and before
  the provider is asked. The reservation answers the settlement's id and the payee's account, so the provider is asked to pay exactly that
  account, `POST /payments { reference, amount, currency, payee }`.
- **A cash settlement needs no payout account,** and neither does a payment already asked for: the rule is checked when a payment is asked,
  and the book's other rules are unchanged.
- **The route sits under the account, in Settlements' routes.** `/accounts/me/payout-account` is mounted with the settlements' routes because the
  aggregate is theirs; the path is the one the client reads it at. Groups keeps `/accounts/me`, and the two paths do not overlap.
- **Nothing is carried across the context boundary.** The account is read in Settlements and the provider is asked in Settlements, so no
  integration event is published and the context map is unchanged. `PayoutAccountSet` is a domain event, recorded by the aggregate and
  published after its commit, as the other Settlements events are; no other context reacts to it.

## Consequences

- A member who was paid through the provider before this request has no payout account until it sets one: a payment asked for it is refused
  by its name. Cash settlements are unchanged.
- An account the provider later forgets is still the member's until it is replaced: Tally does not ask the provider again when a payment is
  asked, so a payment to it is refused by the provider's own answer (`ProviderUnavailable`) and nothing is kept.
- The HTTP adapter's `#call` now serves `GET` as well as `POST`; its refusals are unchanged.

## When to revisit

- When Tally should re-check a payout account with the provider before a payment, rather than trusting the answer it had when it was set.
- When a second provider is paid through, a payout account is per provider, and the aggregate would carry the provider it belongs to.
