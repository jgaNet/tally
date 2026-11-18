# 32. A netting is decided by a Settlements domain service across the groups two members share, and stored with their books

## Context

Request 32 lets a member net what they and another person owe each other, in one currency, across every group the two of them
are members of now, that is not archived. The storm of the feature (conventions/storms/net-across-groups.yaml) decided how: a
domain service of Settlements, NetDebts, reads the shared groups through SettlementMembers, what each still owes through
GroupBalances and the books' pending payments, and asks each SettlementBook to record its settlement (method `net`); a Netting,
small, keeps what was netted; the books are saved in one transaction with it, each at its optimistic version. Ledger learns
nothing new: a net settlement is paid at once and counted as a cash one. The links Ledger → Settlements, Groups → Settlements and
Settlements → Ledger were already carried by the code; the storm owed the command, the query and the event of the netting.

## Decision

- **The rule is one domain service, `NetDebts.decide()`, and no other place decides a netting.** In each shared group, what the
  caller can pay the other is the smaller of what the caller still owes and what the other is still owed, when the caller owes and
  the other is owed; the same the other way round. The amount is the smaller of the two totals; 0 is refused (`NothingToNet`). The
  settlements are made group by group, in the order the groups were created, the earliest first, the caller's leg first, then the
  other's, each the smaller of what is left to net and what the payer can pay there.
- **The capacity is the book's, not a copy of its rule.** `SettlementBook.capacityOf()` is the formula every settlement is decided
  by (`#decide`), counting the payments waiting at the provider as paid (ADR 0014); the netting reads it and never re-derives it.
- **Each settlement is recorded by its book.** `SettlementBook.recordNet()` decides it with the same rules as any settlement and
  records it paid at once, method `net`, with an audit entry `settlement-paid` by the member who asked, and `SettlementRecorded`.
  A net settlement is never in the book's provider `paid` set, so it is never refunded.
- **The netting is an aggregate of its own, small.** `Netting.create()` validates it and records `NettingRecorded`; its id is its
  own, born with it. It is only read, never changed, so it has no `fromSnapshot()`. It keeps who asked, with whom, the currency,
  the amount and its settlements' ids in the order made, and the two members read it; anyone else gets 404.
- **All or nothing, by the books' versions.** The use case reads each shared group's book, then its balances, decides, and saves
  every shared book at the version it was read at, the netted ones and the others alike, then the netting, in the command's one
  transaction. A settlement recorded in between moves a version the save checks, so the command decides again on what the other
  left (CONC-OPTIMISTIC, three attempts). Saving the unnetted books too keeps the amount netted true to what was read.
- **Ledger's statement names the method.** Its `CountedSettlement` method takes `net`, and its statement line reads
  `Settlement by netting`; no other context reacts to the netting.

## Consequences

- The netting's settlements are the books' rows, with the books' audit and history: a netting is visible in every place that
  counts a settlement, and `GET /v1/settlements/{id}` answers `method: net` without a new route.
- A netting that races another settlement of the same groups is decided again, so the second one nets what the first left, or
  is refused by `NothingToNet`.
- The shared groups are read one at a time (one query per group for the members), which is fine for the groups two people share;
  a member with very many groups would make the netting slower, not wrong.

## When to revisit

If a netting must cover more than two members, or a currency that is not one of Tally's, or if a netting must be undone (a
refund of a net settlement, which the request does not ask), a new decision says so: the rule, the books and the netting change
together.
