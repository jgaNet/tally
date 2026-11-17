# 11. A cash settlement is decided in a SettlementBook, and Ledger counts it in every balance

## Context

Request 12 lets the payee of a payment in cash record it, so that the payer's balance goes up by its amount and the
payee's goes down by it, never more than is owed, and two settlements recorded at once are decided one after the other.
The storm (`conventions/storms/settle-in-cash.yaml`) decided four things before the code: a `SettlementBook` per group is
the aggregate every settlement of the group is decided in; Ledger counts what was settled through a port it owns
(`SettledAmounts`), answered over Settlements' read model, so that a balance never lags a payment; the payee, who received
the money, is the one who records it; and a statement stays the expenses' (request 8).

Two things in the profile are new for Settlements, and this ADR brings them in as the profile says they come in: by an
ADR. Settlements is a Lite context (ADR 40), which holds no aggregate and no domain event until a trigger fires. The
trigger that fires here is **several-writers**: every settlement of a group is decided in the same aggregate, so two
writers can reach one book at once and the optimistic check (CONC-OPTIMISTIC) is held where that happens. The domain event
`SettlementRecorded` comes in with the aggregate: the book records it, and it is published after the save, as Ledger's
events are.

The relationship Settlements → Ledger was declared `planned` in the context map (ADR 9, ADR 10) and is carried by this
feature, so its flag is removed in `conventions/domain.yaml`.

## Decision

- **`SettlementBook`, an aggregate per group** (`src/Contexts/Settlements/Domain/SettlementBook/`). It has its own
  generated identity and the version it was read at; `record` is the one way a settlement enters it, and it records
  `SettlementRecorded`. Its store, `SqliteSettlements`, saves it with a version check (CONC-OPTIMISTIC): `save()` stores
  version + 1 and refuses a book that is no longer at the stored version with a `ConcurrencyConflictException`. The
  command retries from a fresh read, up to three attempts (`CONFLICT_ATTEMPTS`), and the third conflict is the refusal.
- **The decision is a pure function** (`decideRecordCashSettlement`) of the group's members, the balances the use case
  read through `GroupBalances`, the caller as payee and the payer and amount as typed. It refuses, as a failed Result: a
  payer who is not a member; a payer who is the payee; an amount that is not a whole number from 1; an amount more than
  the payer owes (the opposite of their balance); an amount more than the payee is owed (their balance).
- **Load, then read the balances, then save.** The use case reads the book (its version) before it reads the balances.
  A settlement that lands after the book was read changes the version, so the save of the other refuses it and the retry
  reads the balances with that settlement counted. A settlement that landed before the book was read is in the balances
  read after it. This order is what makes "each is decided on the balances as the other left them" hold across two
  servers on one database.
- **Ledger counts a settlement in every balance** (T8). Ledger owns `SettledAmounts`, a port in its Application, answered
  by `SettledAmountsOfSettlements` over Settlements' read model (`ISettlementQueries.settledOf`), which gives each member's
  net effect: the payer's balance goes up by the amount, the payee's goes down. `BalancesCountingSettlements` adds that to
  the expenses' balances, and the balances read by `GetGroupBalances`, by Groups' leave (through `MemberBalances`), and by
  Settlements' suggestions (through `GroupBalances`) all read it. A member's statement still lists expenses only.
- **Each context's read model is given lazily**, as ADR 7 says: Ledger's wiring and Settlements' wiring import each other,
  and each reads the other's read model at a request, never when the modules are built.
- **The settlements' database** is the application's file (`SETTLEMENTS_DATABASE_PATH`, else `DATABASE_PATH`), in its own
  tables, opened on first use, with WAL and a busy timeout, as Ledger's is (ADR 5).
- **The API** is `api/12-settle-in-cash.yaml`. `RecordCashSettlement` answers at once: `201 { id }`, `400` for a body whose
  shape is wrong (the transport) or a value the domain refuses, `404` to a non-member of the group. `GetSettlement`
  answers `200` with the settlement, and `404` to anyone who is not a member of its group.

## Consequences

- An expense recorded while a settlement is being decided may or may not be counted by it, as any balance read may. The
  storm decided that only settlements contend for the book, so an expense does not bump its version; the decision is on
  the balances as they were read, and a settlement that could pay more than is owed after a concurrent expense that
  lowers the payer's debt is not refused. The storm accepted this.
- Ledger's balances are now the sum of two reads: the expenses' in one statement, and the settlements' in another. Each
  sums to 0 by construction (an expense and a settlement each move two balances by the same amount, in one transaction),
  so the balances still add up to 0 in every read, whichever instant each part was read at.
- Settlements has one aggregate and one command. The next command that reaches `SettlementBook` (a provider payment,
  request 14 onwards) makes several-writers fire on it by the profile's own rule, and nothing in this ADR has to change.

## When to revisit

At the provider's settlements, when a payment becomes pending before its webhook lands: a pending payment must count
against the balance as paid (ADR 9), and this port already reads every settled amount, so that change is in the answer
of `settledOf`, not in Ledger. And if an expense must be decided against the same book, the expense's version becomes part
of the check, and this ADR's consequence about expenses is revisited with it.
