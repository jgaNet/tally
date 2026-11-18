# 29. Who bears the provider's fee is the book's policy, set by the owner, and a settlement through the provider settles what remains after its payer's part

## Context

Request 38 lets the provider keep a fee on every payment it makes through Tally, and lets the owner of a group decide who bears
it: its payer, its payee, or both, each half. The storm (`conventions/storms/provider-fee.yaml`) decided three hot spots before
the code: the policy is Settlements', on the group's book, because it is a rule of how a settlement settles; the fee comes from
the provider's answer to the payment, through the port Settlements owns; and what Ledger counts is the amount the book says a
settlement settles, never the fee or the policy.

The owner is known to Groups, and Settlements already reads the members, the currency and the archived and suspended flags of
a group through `SettlementMembers`, the port Groups' link carries. Nothing else is needed from another context, so the
context map keeps its two links as declared (Groups → Settlements, Settlements → Ledger).

## Decision

- **The policy is the book's.** Each group's book keeps who bears the provider's fee (`fee_policy`, the payee until the owner says
  otherwise). `SetFeePolicy` (`PUT /v1/groups/{id}/fee-policy`) asks the book to change it; the book refuses anyone but the owner, in
  an archived group, or from a suspended account, and records `FeePolicySet`. The owner's role is read through
  `SettlementMembers.roleOf`, the one answer Groups gives for it.
- **The fee is the provider's, and the book checks it.** The provider's answer to a payment carries `fee`. An answer without one
  is no answer (the payment is refused and nothing is kept, as for a missing link). A fee the book cannot bear (not a whole number,
  0 or more, or not less than the amount) is refused by the book, `ProviderFeeInvalid`, before anything is kept.
- **A settlement keeps what it settles.** A payment asked for keeps its `fee` (amount, and who bore it, as the policy was then) and
  its `settled_amount`: the amount less the part of the fee its payer bears (all of it for the payer, none for the payee, half rounded
  down when shared, so the payee bears the odd hundredth). The `amount` stays the one asked for, and is what the provider is asked
  for. A settlement with no fee (in cash, in netting, or asked before this request) settles its amount.
- **Ledger counts what is settled, through the same reads.** The balances, the waiting payments, the suggestions, the statement and
  the audit read `COALESCE(settled_amount, amount)`; Ledger's port is unchanged and never sees the fee or the policy.
- **The fee is read with the settlement.** A settlement asked for from now on also reads `fee`, and `GET /v1/groups/{id}/fee-policy`
  reads the policy to a member of the group only.

## Consequences

- A payer who bears the fee still owes it after the payment: the balance is left with the fee owed, as the example in the request
  shows (300 with a fee of 31 settles 269 when the payer bears it).
- The refusal check on what is owed still reads the amount asked, as it did; only what the settlement moves on the balances is the
  settled amount. Revisit it if a product rule says a payment may not ask more than the payer owes after its fee.
- A change of policy changes no payment asked for before it: each keeps the fee and who bore it from its asking, so the audit and
  the statement of past settlements do not move.
- Two tables gain columns in place (`settlement_books.fee_policy`, `settlements.settled_amount`, `fee_amount`, `fee_borne_by`);
  an existing row has no fee and settles its amount, with no backfill.
