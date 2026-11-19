# 36. Provider fee: the owner decides who bears it, the book keeps the fee and what a settlement settles, as it was asked

## Context

Request 38 (`api/38-provider-fee.yaml`) has the payment provider say its fee for each payment through it (`201 { id, payUrl, fee }`, a whole number
of hundredths, 0 or more, less than the amount). Each group's owner decides who bears that fee: its payer, its payee, or both, shared; until they
decide, the payee bears it, as before. A settlement through the provider settles its amount less the part of the fee its payer bears, and that
settled amount is what everything that counts a settlement counts (the balances, what is still owed, the statement's `paid` and `share`, the audit's
`amount`). Its `amount` stays the one asked for. A settlement keeps the fee and who bore it as they were when it was asked for.

The storm (`conventions/storms/provider-fee.yaml`) decided that the policy is on Settlements' `SettlementBook` of the group (`FeePolicySet`), that the
fee comes from the provider's answer through the `PaymentProvider` port and is validated by the book's decision, and that Ledger counts only the
amount the book says a settlement settles, through `SettledAmounts`. The links Groups → Settlements (`SettlementMembers`) and Settlements → Ledger
(`SettledAmounts`) are already in the context map, so no context and no relationship is added.

## Decision

**The policy is the book's.** `SettlementBook` holds `feeBorneBy` (`payer`, `payee`, `shared`; `payee` when never decided). `setFeePolicy` sets it and
records `FeePolicySet`. `SetFeePolicy` (`PUT /groups/{id}/fee-policy`) is a command answered at once, `204`: the caller must be a member (else the group
does not exist for them), the group's owner (`ownerOf`, read through `SettlementMembers`, else `403`), and the group not archived (`GroupArchived`). The
book is read first and saved with its version, so the decision and the save are one state (CONC-OPTIMISTIC). `GetFeePolicy` (`GET /groups/{id}/fee-policy`)
is a query any member reads.

**The fee is validated where it is taken.** `PaymentLink` carries the `fee` the provider said, or none. The use case takes it through
`decideProviderFee`: it is kept only as a whole number, from 0, less than the amount, with the policy the book holds at that moment. Otherwise the
payment is refused (`ProviderFeeUnavailable`), and nothing is kept, as for a provider that gives no link. The check is a pure decision (DOMAIN-NON-DETERMINISM):
the port answers a plain value and the book decides what to do with it.

**What a settlement settles is decided when it is asked for.** `settledAmountOf(amount, fee)` is `amount` less the payer's part: all of the fee when the
payer bears it, half of it rounded down when shared (so the payee bears the odd hundredth), none when the payee bears it. The settlement keeps `fee`
(`{ amount, borneBy }`) and `settled`. Every count reads `settled`: `settledOf` (Ledger's balances), `pendingOf` (what is still owed), `countedOf` (the
statement) and `auditOf` (the audit). The read model's `amount` is the one asked for, and `fee` is read through `GET /settlements/{id}` for a settlement
through the provider asked for from this request on.

**Stored as it is decided.** The `settlement_books` table keeps `fee_borne_by` (default `payee`); the `settlements` table keeps `settled`, `fee_amount` and
`fee_borne_by`. A row written before this request has no `settled` and no fee: the reads take its `amount` (`COALESCE`), so no row is rewritten.

## Consequences

- Settlements gains one command, one query and one event; its `ISettlementMembers` gains `ownerOf`, and its `PaymentLink` gains `fee`. Ledger changes
  nothing: its `SettledAmounts` port now carries the amount each settlement settles. The context map and the storm's links are unchanged.
- The provider's answer must carry `fee`. Existing fakes of the provider in the tests answer `fee: 0`, which settles the amount as before.
- When the provider gives a payment link but no usable fee, the provider keeps a payment Tally never records, as it does for a link that is refused
  after the provider answered; that payment is not counted and not refunded by Tally.
- A settlement asked for before this request settles its amount and reads no `fee`.

## Rejected alternatives

- **A policy per member, or on the group's own aggregate.** The storm decided the book holds the policy: it is a rule of how a settlement settles, and
  the book is where settlements are decided. The group's own aggregate would be a second place for it.
- **Taking the fee in the decision before the provider is asked.** The fee is the provider's answer, so it is unknown until the provider has answered.
- **Changing the stored amounts instead of keeping a settled amount.** Then the amount asked for would no longer be the one stated, and a policy change
  would have to rewrite past settlements; the request says changing the policy changes no settlement.
