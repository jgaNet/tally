# 27. A netting is a domain service over the books it spans, and an aggregate of its own

## Context

Request 32 nets what two people owe each other across every group they share, in one currency, as settlements that count
at once. The storm (`conventions/storms/net-across-groups.yaml`, decided before the run) put the decision in Settlements:
a netting spans several `SettlementBook`s, each with its own version, and it must be all or nothing and never pay more
than is still owed, with two nettings or a netting and a cash settlement asked at the same moment.

## Decision

- **No new context and no new relationship.** Every link the netting needs is already declared in the context map:
  Ledger's balances (`GroupBalances`), Groups' members (`SettlementMembers`), and Settlements' settled amounts read by
  Ledger (`SettledAmounts`). Settlements already reads Groups' roster through its port, so the shared groups come from
  that port too: `groupsShared` reads Groups' `groupIds` and each group's members, and answers the groups both
  accounts are members of now, the earliest first, with their currency and whether they are archived.
- **The decision is a pure domain service, `planNetting`**, of Settlements. It reads the books as they stand (the
  balances the ledger counts, and the payments waiting at the provider) and answers the amount, the lesser of the two
  totals, and the payments: the first member's to the second group by group, then the second's to the first. It asks no
  port and reads no clock.
- **Each payment is recorded by its group's book** (`SettlementBook.recordNet`), with the book's own refusal rules, so
  no book is written past what it owes. A group is paid in one direction only, since in it one of the two owes the
  other, so each group gets at most one payment.
- **A netting is a small aggregate, `Netting`**, which records `NettingRecorded` when it is made. It keeps who asked,
  with whom, the currency, the amount and its settlements' ids in order. Its identity is generated when it is made.
- **All or nothing is the command's transaction.** The use case saves every book at its version, writes the audit
  entries, and saves the netting, all in the one transaction of the command (ADR 25). A conflict on any book is a
  `ConcurrencyConflictException`, and the command re-reads and re-decides the whole netting, up to three attempts. A
  second netting decided at the same moment finds the books the first wrote and is refused as `NothingToNet`.
- **A currency that is not one of Tally's has no group to net in, so it is refused as `NothingToNet`.** Settlements does
  not keep a list of currencies of its own, since Groups and Ledger each already do; no group is in such a currency,
  so the same refusal holds without the list.

## Consequences

- A netting's settlements are counted at once, through `paid` and the balances, as a settlement in cash is; they carry
  the method `net`, which Ledger's statement names `Settlement by netting`. A netted settlement is never refunded:
  refunds are for a provider's payment only.
- The `settlements` table's `method` check now allows `net`. A database created before this feature keeps the old
  check and needs the constraint replaced before a netting is made there; the schema is created with `IF NOT EXISTS`,
  as every table of this application is.
- The netting reads the groups through the roster's `groupIds`, one group at a time. That is linear in the number of
  groups an application has; a read that lists the groups two accounts share would replace it if that ever matters.

## When to revisit

If the groups two accounts share grow large enough for reading every group to be slow, the roster gets a read of the
groups shared by two accounts, and `groupsShared` asks it instead.
