# 37. The owner decides who bears the provider's fee, and a settlement keeps the fee it was asked with

## Context

Request 38 has the provider say its fee when Tally asks it for a payment, a whole number of hundredths, 0 or more, which it keeps out of
what it pays the payee. Each group decides, through its owner, whether the payer, the payee or both, shared, bear it; until then the payee
does, as before. A settlement through the provider settles its amount less the part of the fee its payer bears, and what it settles is
what the balances, the statements, the waiting payments and the audit count. The storm of the feature
(conventions/storms/provider-fee.yaml) decided where each part lives. No context and no relationship is added: Settlements already holds
the members and the owner through its SettlementMembers port, and Ledger already reads what is settled through SettledAmounts.

## Decision

- **The policy is a rule of the group's settlement book.** `SettlementBook` holds who bears the fee (`payee` until decided). `setFeePolicy()`
  is decided by the owner alone (`NotAllowed` for another member, `GroupArchived` in an archived group, `InvalidFeePolicy` for a bearer that
  is not payer, payee or shared), and records `FeePolicySet`. The owner is the group's `ownerId`, read through SettlementMembers.
- **The fee is the provider's answer, validated by the book.** `PaymentProvider.requestPayment()` answers the fee with the link; an answer
  without a whole fee of 0 or more is not an answer (`ProviderUnavailable`, nothing is kept). The book refuses a fee that is not less than the
  payment (`ProviderFeeNotAccepted`), with nothing kept.
- **What a settlement settles is fixed when it is asked for.** The book keeps the fee, who bore it, and what it settles: its amount, less the
  payer's part (all of the fee for `payer`, none for `payee`, half rounded down for `shared`, so the payee bears the extra hundredth). The
  settlement keeps this when the owner decides again later. A settlement asked for before has no fee and settles its amount.
- **Every count reads what the settlement settles.** The balances, the statement, the waiting payments and the audit's `amount` read the
  settled amount (`COALESCE(settled, amount)`); the settlement's `amount` stays the one asked for, and is what the provider is asked for.
  Ledger reads it through the same SettledAmounts port, so Ledger never reads the fee or the policy.

## Consequences

- A settlement through the provider asked for from this request reads `fee: { amount, borneBy }`. The group's policy is read by its members
  (`GET /groups/{id}/fee-policy`) and decided by its owner (`PUT`).
- The store keeps the policy on the group's book row (`settlement_books.fee_borne_by`), written with the book's version (CONC-OPTIMISTIC),
  and each settlement row keeps `settled`, `fee_amount` and `fee_borne_by`; settlements from before read as paying their amount.
- The provider's payment is created before the fee is checked: a fee refused after the provider answered leaves that payment with the
  provider, unpaid, as a link Tally never keeps, as for a link that the store refuses.

See also: docs/adr/0013 (a settlement is decided by the group's book), docs/adr/0014 (a settlement through the provider is pending in the
book), docs/adr/0028 (the statement counts the settlements that count), docs/adr/0033 (a contested settlement is held in the book).
