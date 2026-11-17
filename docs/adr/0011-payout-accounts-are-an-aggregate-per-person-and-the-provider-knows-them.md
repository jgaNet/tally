# 11. A payout account is an aggregate per person, and the provider says whether it knows it

## Context

Request 16 of Tally (a member sets the account the provider pays them on, which the provider must know; from now on a member is
paid through the provider only with one) was stormed before the code (`conventions/storms/payout-accounts.yaml`, decided with the
product's owner). The storm decided that the payout account lives in Settlements, that the provider answers whether it knows an
account, and that the payment's refusal is made in the book, from the payee's payout account read through its repository.

The Lite profile holds an aggregate only where a trigger brings it in by an ADR. Settlements already holds one (`SettlementBook`,
ADR 10, the several-writers trigger), so this ADR records the second: `PayoutAccount`, one per person.

## Decision

- **`PayoutAccount` is an aggregate root, one per person** (`Domain/PayoutAccount/PayoutAccount.ts`). It generates its own
  identity when it is created (`Id.generate()` in `create()`, DOMAIN-IDENTITY), and carries the owner's account id and the
  provider's id of the account. `create()` refuses an account the provider does not know, and records `PayoutAccountSet`.
  `set()` replaces the provider's account of an existing one, under the same refusal, and records the same event.
  `fromSnapshot()` reads one back and records nothing.
- **Only the owner's own account is read or set.** `SetPayoutAccount` and `GetPayoutAccount` take the caller as the owner; a
  caller reads their own payout account and no one else's (`404` when they have none).
- **The provider says whether it knows an account.** The port `IPaymentProvider.payoutAccountFor` answers the provider's `{ id }`
  for an account it knows, or nothing: any other answer, a timeout, or no configured base URL is nothing, and the account is refused
  (`UnknownPayoutAccount`, `422`). The aggregate takes the answer or refuses it; it never calls the provider itself.
- **The book refuses a payment to a payee without a payout account, before the provider is asked** (`PayeeHasNoPayoutAccount`,
  `422`). `SettlementBook.proposePayment` takes the payee's `PayoutAccount` (read by `IPayoutAccountStore`), after its own rules, so
  the rules that already refuse a payment keep their names. The proposal carries the payee's provider account id, and the request
  to the provider says it as `payee`.
- **A payout account is a store of its own**, `IPayoutAccountStore`, over the table `payout_accounts` (one row per owner, unique),
  saved at its version with the same check as the book (CONC-OPTIMISTIC): a second set decided at once meets the version check and
  is decided again on the first one's account.
- **No relationship between contexts is added.** The provider is an outside system behind a port Settlements owns (ADR 8), and the
  account's owner is an account id Settlements already receives from the caller. The context map is unchanged.

## Consequences

- A member who has no payout account cannot be paid through the provider; a cash settlement needs none. A payment already asked for
  is unchanged: its webhooks and refunds do not read the payout account.
- The provider's answer is read at the moment a person sets their account, and again at the moment a payment is asked, through the
  payout account the book reads then. Tally keeps the provider's id of the account, not a copy of the provider's view of it.
- Two sets of the same person decided at once: the second is decided again on the first's account, or is refused as a conflict
  after the use case's three attempts.

## When to revisit

When the provider stops answering whether it knows an account as it does now (for example, when an account can be unknown for a
reason Tally must tell apart), the refusal of a set is split by that reason, and the storm is revisited first.
