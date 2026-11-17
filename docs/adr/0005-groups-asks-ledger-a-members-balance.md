# 5. Groups asks Ledger a member's balance (the Ledger → Groups link, carried)

## Context

ADR 1 decided that Groups asks Ledger a member's balance through a port it owns, `MemberBalances` (T5), when it decides
whether a member may leave, and recorded the relationship as `planned` until the code carried it. Request 9 (leaving a
group, once one's balance is 0) is the first feature that needs it. The storm `leave-a-group` decided the hot spots:
Groups asks Ledger through `MemberBalances`, answered over Ledger's balances read model, and the Group refuses while
the balance is not 0 and always refuses the owner; a former member's expenses are frozen by the Expense, which asks
the current members of the group.

The link runs both ways now: Ledger already asks Groups who is a member (`GroupMembers`, ADR 3), and Groups asks
Ledger the balance. Each side's adapter needs the other side's read model, and each context's wiring builds its own.

## Decision

- **The relationship Ledger → Groups is carried now**, by the owned-port mechanism of ADR 1: `conventions/domain.yaml`
  no longer marks it `planned`. Groups' port is `IMemberBalances` (`Domain/Group/Ports`), in Groups' words: the balance a
  member has in a group, as Ledger counts it. The group decides with it: `Group.leave` refuses the owner and any balance
  that is not 0.
- **The adapter is Groups'**: `LedgerBalances` (Groups' Infrastructure) implements the port over Ledger's
  `IBalanceQueries` (Ledger's Domain port, which Infrastructure may read).
- **The read model is built by the composition root**, `src/Bootstrap/Fastify/readModels.ts`, not by Ledger's wiring.
  Ledger's wiring already imports Groups' wiring for `groupQueries` (ADR 3). Had Groups' wiring imported Ledger's wiring
  for its balances, the two wiring files would import each other, and the module-level construction of each would
  depend on the order the files load in. The composition root builds the read model once, and both wirings may import
  the composition root (ARCH-WIRING: `bootstrap`). Ledger's own wiring keeps its own instance of the same stateless read.
- **Groups keeps its former members.** A member who leaves is taken out of the members and kept among the former
  members (a table of their own, `former_members`), so that the group still knows every account that has been one: a
  former member's statement is read by the group's members, and Ledger asks `IGroupMembers.hasBeenMember` for it. A
  member who joins again is taken out of the former members and put last, from the moment they join.
- **Ledger's expenses are frozen for a former member.** An expense whose payer or a member of its split is no longer a
  member is refused on an edit or a deletion (`ExpenseOfFormerMember`), so that their balance stays 0 and the group's
  balances still add up to 0. Recording an expense already refuses a former member, since the split is asked of the
  current members.
- **The gap of T5 stays a known gap**, as the storm decided: an expense recorded at the very moment its member leaves is
  decided in two contexts, with no transaction across them; no hidden test sends the two at once.

## Consequences

- The context map carries both relationships; `yarn check:conventions` holds the code to them (CTX-MAP-DECLARED).
- Groups' wiring imports the composition root, which imports Ledger's Infrastructure: the composition root is the one
  place that sees two contexts' read models, and nothing else does.
- Groups' `group_members` holds the current members only; the former members are in `former_members`. The existing
  database keeps its rows: the new table is created when the repository is.
- A member's balance is read in the leave's transaction, which sees the expenses written so far; an expense committed
  after the read is not counted (the T5 gap above).

## When to revisit

When request 20 changes leaving (the gap of T5 is then closed, or accepted again for the product's owner to decide), or
when a second process shares the file: the balance read would then be one process's view of another's writes.
