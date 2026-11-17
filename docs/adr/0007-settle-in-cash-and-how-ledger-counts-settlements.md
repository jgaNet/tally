# 7. Settle in cash: Settlements decides in a book per group, and Ledger counts what was settled

## Context

Request 12 records a settlement in cash: the payee of a payment, a member who received it, records who paid and how
much. A settlement changes what each member is owed at once, so every reader of a balance counts it: the group's
balances, the suggested settlements (request 11), and leaving a group (request 9). Two settlements recorded at the same
moment must not together pay more than is owed. The storm (`conventions/storms/settle-in-cash.yaml`, its hot spots T7
and T8) decided the shape before the run; this ADR records what the code now carries of it.

The relationships it needs were declared by ADR 5 as `planned`: Settlements → Ledger (`SettledAmounts`, T8). The other
two (Ledger → Settlements, `GroupBalances`, and Groups → Settlements, `SettlementMembers`) were carried since request 11.

## Decision

- **The settlements of a group are decided in one book**: `SettlementBook`, an aggregate per group (T7), with its
  version. Recording a settlement checks it in the book: the amount is a whole number of at least 1, the payer is a
  member and not the payee, and the amount is no more than what the payer owes and no more than what the payee is
  owed. The book refuses with a failed Result, and nothing is stored. Only settlements contend for it; expenses do not.
- **The balances a settlement is decided on are read inside the command's transaction.** The command reads the book at
  its version, then the balances (`GroupBalances`, in the transaction, through `groupBalanceSumsInCommand`), and the
  book's optimistic check (CONC-OPTIMISTIC) stores its settlement at version + 1 only if the book is still at the version
  it was read at. A second settlement decided at once conflicts, is re-read by the command (three attempts), and reads
  the first one's settlement in the balances. The last conflict is the refusal.
- **Ledger reads what was settled** (`SettledAmounts`, T8): a port Ledger owns (`ISettledAmounts`). Its adapter,
  `SettlementsSettledAmounts`, answers it over the read Settlements' wiring exports (`ISettlementEffects`, in
  Settlements' Domain, as Groups' `IGroupMembership` is for Ledger, ADR 3). A payer's balance goes up by what they paid,
  a payee's goes down by what they received. Every balance Ledger reads counts it: the group's balances, the suggestion's
  input, and a member's balance when they leave. A member's statement (request 8) still lists expenses only.
- **Bootstrap hands Settlements the balances.** Ledger's wiring imports Settlements' wiring (for `settlementEffects`), so
  Settlements' wiring no longer imports Ledger's: `settlementsModuleWith(balances, balancesInCommand)` takes them, and the
  composition root builds them from Ledger's exports. The two wirings never import each other, as ADR 4 required for Groups.
- **The link Settlements → Ledger is no longer `planned`** in the context map (`conventions/domain.yaml`).

## Consequences

- A settlement's effect on a balance is read, never copied: the balances count it as soon as it is recorded.
- A query's balance is read in two statements, the expenses' entries and then the settlements' effects, each outside any
  transaction; a settlement committed between them moves a member's balance by its amount, and the group's balances still
  add up to 0, since a settlement's effects always do.
- Expenses are not part of the book: an expense recorded at the same moment as a settlement is not checked against it.
  The storm decided this (only settlements contend for the book), and the case is the same one ADR 4 named for leaving.
- The payee records the settlement, so the payer cannot claim a payment the payee never had.

## When to revisit

When a payment through the provider lands (`PaymentProvider`, pending settlements, webhooks late or twice), since a
pending payment then counts as paid for what is still owed and the book must decide on it too; and when an expense and a
settlement must not be decided at the same moment on one database (the gap ADR 1 named).
