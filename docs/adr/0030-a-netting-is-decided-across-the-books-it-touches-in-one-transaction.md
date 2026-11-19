# 30. A netting is decided across the books it touches, in one transaction, and is an aggregate of its own

## Context

Request 32 nets what two people owe each other across the groups they share, in one currency, as settlements of each group that count at
once. A netting spans several groups, so several settlement books (ADR 11), each with its own version (CONC-OPTIMISTIC), are decided
together: every book read must still be at the version it was read at when the netting is saved, or the netting is decided again on what
the other writer left, and no book is ever written past what it owes. The storm (`conventions/storms/net-across-groups.yaml`) fixed the
shape: a domain service of Settlements decides it, a small aggregate keeps the record, and Ledger learns nothing new. What was left to
decide is where the groups come from, what the netting is, and how the audit names who asked.

## Decision

- **The groups the two share come through `ISettlementMembers`.** Settlements' port over Groups' read model gains `sharedGroupsOf`, which
  reads the groups the asker is in (`groupsOf`) and keeps those the other is a current member of too (`membersOf`), earliest first, each with
  its currency and whether it is archived. No new relationship is declared: Groups → Settlements already carries `SettlementMembers`.
- **The decision is pure and reads what the use case gives it.** `decideNetDebts` (`Netting.decision.ts`) takes the shared groups, each with
  the balances its book counts (`stillOwed`, ADR 12), and answers the amount and the settlements by the stated rule. It refuses a netting with
  oneself, in a currency that is not Tally's, and one that nets nothing. It reads no store and no clock.
- **Every shared group's book is read, and every one read is saved, in one transaction.** The amount depends on every group's balances, so a
  change to any of them moves its version and the netting is decided again (the command's three attempts, CONC-OPTIMISTIC). A netting that
  nets nothing returns before anything is written.
- **A netting is an aggregate of its own, registered once.** `Netting.register` records `NettingRecorded`, is saved in the same transaction as
  the settlements it made, and is never changed, so it is created and not loaded. Its settlements are kept in the order they were made.
- **The settlements are `method: net`, a status of the settlement, not a new kind of money.** A net settlement is paid at once and counted
  through `SettledAmounts` like a cash one, so Ledger's balances, its statement (`Settlement by netting`) and the suggestions need no change
  beyond the wording. It is never refunded: the refund decision already refuses a settlement not made through the provider.
- **The audit names who asked.** A settlement's paid line is by the member who asked the netting, which the netting's table keeps; a cash
  settlement is by its payee and a provider one by its payer, as before.

## Consequences

- A netting reads every book of the groups the two share, so a settlement in any of them, however unrelated to the amount, makes the netting
  decide again. That is the cost of all-or-nothing across books; it is bounded by the number of groups two people share.
- Groups' `groupsOf` and `membersOf` are read once per group the asker is in: correct, and a read per group. A read model listing the shared
  groups would make it one read; it is not needed at the size Tally runs at.
- The published language and the context map are unchanged: no integration event is added, and the relationships the storm declares already exist.

## Revisit when

- Netting spans more groups than a person shares in practice, or the N+1 reads show in the request time: a read of the shared groups in one
  statement, in Groups' read model.
