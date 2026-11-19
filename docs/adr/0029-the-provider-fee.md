# 29. The provider's fee: the SettlementBook holds the group's policy and fixes each settlement's fee when it is asked for

Status: accepted (request 38)

## Context

Request 38: the provider keeps a fee on every payment. From now on the provider says the fee when Tally asks it for a payment
(request 13): `201 { id, payUrl, fee }`, `fee` a whole number, 0 or more, in the hundredths of the currency, kept out of what the
provider pays the payee. Each group's owner decides who bears it: the payer, the payee or both, shared; the payee until then.
A settlement through the provider settles its amount less the part of the fee its payer bears (the payee bears the extra
hundredth of an odd shared fee). What a settlement settles is what the balances, the suggestions, the statement and the audit
count; its `amount` stays the one asked for.

The storm (`conventions/storms/provider-fee.yaml`) decided the hot spots before the run: the policy is in Settlements, on the
group's SettlementBook; the fee comes from the provider's answer through the PaymentProvider port and the book validates it;
Ledger counts what a settlement settles, through SettledAmounts, and never the fee or the policy. Its links, Groups →
Settlements (SettlementMembers) and Settlements → Ledger (SettledAmounts), are carried already. No context is new and no
relationship is new.

## Decision

- **The policy is the book's.** `SettlementBook` holds the group's `feePolicy` (`payer`, `payee` or `shared`, the payee when no
  owner decided), stored with its version in `settlement_books.fee_borne_by`. `SetFeePolicy` (`PUT /groups/{id}/fee-policy`)
  is answered at once and runs in the transaction of the change: the book refuses it unless the caller is the group's owner
  (OnlyTheOwnerSetsFeePolicy), the group is archived (GroupArchived), or the value is not one of the three (InvalidFeePolicy).
  It records `FeePolicySet`. `GetFeePolicy` (`GET /groups/{id}/fee-policy`) answers a member from the read side.
- **The owner is read through SettlementMembers.** `ISettlementMembers` gains `roleOf(groupId, accountId)`, answered by
  `GroupsSettlementMembers` over Groups' membership read side (`IGroupMembership.roleOf`, which exists). Settlements asks it;
  it never reads Groups' tables.
- **The fee comes from the provider's answer, and the book decides it.** `PaymentLink` carries `fee`. The HTTP adapter
  refuses an answer without a whole-number fee as ProviderUnavailable, so nothing is kept. The book then refuses a fee that is
  not 0 or more and less than the amount (ProviderFeeOutOfRange); the payment is then refused and nothing is kept.
- **A settlement keeps its fee and its `settled`.** `keepPayment` stores the fee the provider said, who bore it (the policy
  in force then), and what the settlement settles: `amount`, less the payer's part (all of the fee for `payer`, none for
  `payee`, floor(fee / 2) for `shared`). Changing the policy later changes no settlement. A settlement asked before this
  request has no fee and `settled` is its amount (the column is NULL and every read takes `COALESCE(settled, amount)`).
- **What settles is what counts.** The balances (`PostgresSettlementEffects`, through SettledAmounts), the statement
  (`PostgresCountedSettlements`), the audit (`PostgresSettlementAuditEntries`) and the book's `stillOwing` (the suggestions and
  the netting) read `settled`. The debt check of a payment still refuses by its `amount`: `settled` never exceeds it, so a
  payment the book accepted under that check is never one the balances cannot settle.
- **The read side.** A settlement through the provider asked from now on reads `fee: { amount, borneBy }`; the schema allows
  `fee` only on a settlement through the provider.

## Consequences

- Ledger's ports and its counting do not change: it reads what a settlement settles through the port it already has.
- The settlements table gains `settled`, `fee_amount`, `fee_borne_by`, and the book gains `fee_borne_by`; the migrations add
  them `IF NOT EXISTS`, and nothing is backfilled, so an older row settles its amount by its NULL `settled`.
- Every e2e fake of the provider answers `fee`, as the provider does now; a fake that answers without one is refused.

## When to revisit

When the fee must be re-decided on a settlement already asked (a refund of the fee, a fee the provider changes after the
payment), when the owner must be read from a different place than Groups' membership, or when Ledger must count the fee itself
(a statement line for the fee), each of which is a new decision and needs its own storm.
