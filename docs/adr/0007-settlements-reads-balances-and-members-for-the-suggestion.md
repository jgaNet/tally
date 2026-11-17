# 7. Settlements asks Ledger the balances and Groups the members (the Ledger → Settlements and Groups → Settlements links, carried)

## Context

ADR 6 declared Settlements, empty, and the five relationships it will have, all `planned` until the code carried them.
Request 11 (suggested settlements) is the first feature of Settlements: a member reads the transfers that would bring
every balance of the group to 0, made by a stated algorithm (the storm `suggested-settlements`, decided with the
product's owner). Its hot spots decided the context that answers it (Settlements, not Ledger), that the suggestion is
not kept (a query, computed at the read, nothing recorded or published), and that the algorithm is the stated greedy
one, not a minimum.

Computing the suggestion needs two things the Settlements context does not have: the balances, which only Ledger keeps,
and the members in the order they joined, which only Groups knows. Both are read through ports Settlements owns, so
the two relationships it needs now are the two links of ADR 6 that carry request 11: Ledger → Settlements
(`GroupBalances`) and Groups → Settlements (`SettlementMembers`).

## Decision

- **The two relationships are carried now.** `conventions/domain.yaml` no longer marks them `planned`. The other three
  of ADR 6 (Settlements → Ledger, Ledger → Notifications, Settlements → Notifications) stay `planned` until the
  features that carry them.
- **Settlements' ports are in its own words.** `IGroupBalances` (`Settlements/Domain/Settlement/Ports`): what each
  member owes (negative) or is owed (positive) in a group, as the expenses recorded so far count it. `ISettlementMembers`:
  the current members of a group in the order they joined, when the asking account is one of them; null otherwise, as
  if the group did not exist. Neither domain imports Ledger or Groups.
- **The adapters are Settlements'.** `LedgerGroupBalances` (Settlements' Infrastructure) implements `IGroupBalances`
  over Ledger's `IBalanceQueries`, and `GroupsSettlementMembers` implements `ISettlementMembers` over Groups'
  `IGroupQueries`. Infrastructure may read another context's Domain ports and read models, and nothing further in.
- **The read models are passed by the wiring, as ADR 5 decided.** Ledger's balance read model comes from the composition
  root (`ledgerBalanceQueries`, `src/Bootstrap/Fastify/readModels.ts`); Groups' read model comes from Groups' wiring
  (`groupQueries`), which Settlements' wiring may import for what it exports (ARCH-WIRING). Nothing imports Settlements'
  wiring, so no import cycle is possible.
- **The suggestion is a pure rule in the domain.** The stated algorithm is a function of the balances in join order and
  nothing else (no clock, no port, no randomness); the query handler reads the two ports and hands the values to it.

## Consequences

- Ledger's balances and Groups' members are read through their read models, the same way Groups and Ledger already read
  each other. The balance read here is the one Ledger counts, with no new count kept by Settlements.
- The query is answered only to the members of the group: membership is asked of Groups in the same read, so a
  stranger finds no group, as the rest of the API does.
- The context map now declares four relationships carried and three planned. The planned ones are decided and not yet
  built.

## When to revisit

When the settlement book (request 12 onward) needs the balances in the same transaction as a settlement is decided:
the ports are then read in one file's transaction, and this link's read is one process's view of another's writes,
as ADR 5 already notes. Also when Settlements → Ledger (`SettledAmounts`) lands, since a balance will then count the
settlements that were paid.
