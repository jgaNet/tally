# 10. Payout accounts live in Settlements, and a payment is paid to the payee's account

## Context

Request 16 lets a member tell Tally which account at the payment provider they are paid on, and makes that account required
to be paid through the provider (ADR 8). The storm (`conventions/storms/payout-accounts.yaml`, its hot spots) decided the
shape before the run: the payout account is an aggregate of its own, per person, in Settlements; the provider answers whether
it knows an account, through the `PaymentProvider` port Settlements already owns; and "required to be paid" is decided in the
SettlementBook, before the provider is asked. The route sits under `/accounts/me` only because the client reads it there.

The storm did not need a context or a link between contexts: the account is the provider's word, and only paying through the
provider needs it. So the feature adds no relationship to the context map, and `conventions/domain.yaml` already named the term
(`PayoutAccount`, under Settlements).

## Decision

- **A payout account is an aggregate of Settlements, one per person.** `PayoutAccount` is made by `create()` on the provider's
  answer, and replaced by `change()`, which keeps its identity and its version; each records `PayoutAccountSet`. It takes the
  provider's answer (`{ id }`, or null for an account the provider does not know) and refuses null, or an answer for another
  id, with `UnknownPayoutAccount`. Nothing is kept on a refusal.
- **The provider is asked through the port Settlements owns.** `IPaymentProvider.findPayoutAccount(accountId)` is
  `GET {PROVIDER_URL}/accounts/{id}`: `200 { id }` for an account it knows, `404` for one it does not, and a failed Result for
  anything else, or for no answer within 5 seconds (`ProviderAccountUnavailable`). `SetPayoutAccount` (signed in,
  `PUT /v1/accounts/me/payout-account`, answered `202` with its operation, as every command is) asks the provider first and then
  stores the account. `GetPayoutAccount` (`GET /v1/accounts/me/payout-account`) answers the caller's own account, `200 { accountId }`,
  or `404` when the caller has none.
- **The book refuses a payee with no account before the provider is asked.** `SettlementBook.proposePayment` takes the payee's
  payout account id, read by the command from the payee's PayoutAccount through its repository, and refuses
  `PayeeHasNoPayoutAccount` after the settlement's own rules. The payment is then asked with that account as `payee`:
  `POST {PROVIDER_URL}/payments` `{ reference, amount, currency, payee }`. A cash settlement needs no account.
- **A payment already asked for goes on as it was.** Only a new payment reads the account, and it reads the account the payee
  has at the moment Tally asks; a replaced account pays the payments asked after it.

## Consequences

- Setting an account is one more command the provider is called inside, so the provider's answer is read in the command's
  transaction, as a payment's link is (ADR 8). A slow provider holds that transaction for at most 5 seconds.
- The payout account is not part of the settlement: a settlement records who paid whom and the provider's payment, not the
  account it was paid to. The provider holds that fact for the payment it made.
- Existing payments through the provider are not re-checked: a payee who replaces their account later is paid where the new
  account is, only for payments asked after the change.
- The `payout_accounts` table is in the Settlements file; a database from before this feature gets it on the next start, as the
  other tables do (ADR 2).

## When to revisit

When the provider's account must be checked again before a payment is paid (a payout account the provider later closes), or
when a payment must name the account it was paid to on the settlement itself (for a statement the payee reads), or when an
account must be set for someone other than the caller (an administrator), which the storm did not decide.
