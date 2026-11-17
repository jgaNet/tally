# 3. Ledger asks Groups who may be in a split

## Context

Request 4 records an expense split between members of a group, and reads it back. Ledger must know which accounts may be
in a split, and who is a member when it decides. ADR 1 decided that Ledger asks Groups through a port it owns
(`GroupMembers`, T3), answered over Groups' read model, and that the relationship stays `planned` in the context map until
the code carries it. This is the first feature that needs it.

## Decision

- **The relationship Groups → Ledger is carried now**, by the owned-port mechanism of ADR 1: `conventions/domain.yaml`
  no longer marks it `planned`. Ledger's port is `IGroupMembers` (`Domain/Expense/Ports`), in Ledger's words: the
  account ids of a group's current members, in the order they joined, when the asker is one of them.
- **The adapter is Ledger's**: `GroupsMembership` (Ledger's Infrastructure) implements the port over Groups' read model
  `IGroupQueries.listMembersOf`. Ledger's Infrastructure may read another context's Domain (its ports and read models), and
  no more: it never imports Groups' handlers, adapters or repositories.
- **Groups' wiring exports its read model** (`groupQueries`), as ARCH-WIRING asks: Ledger's wiring imports that export and
  nothing else of Groups. Groups does not learn of Ledger; it publishes nothing for this, since a member who has just
  joined can be in a split at once (ADR 1).
- **Who may be in a split is refused by the Expense**: a member listed who is not a current member, a member listed
  twice, or a split without its payer. A caller who is not a member of the group sees the group as not there.
- **The reverse relationship stays planned**: Ledger → Groups (`MemberBalances`, T5) is carried when request 20 needs it.

## Consequences

- The context map carries one relationship more; `yarn check:conventions` holds the code to it (CTX-MAP-DECLARED).
- Ledger depends on Groups' read model being answered in the same file: both contexts' stores live in one SQLite file
  (ADR 2), so a read sees the members as of the command's turn.
- A leave of a member, when request 20 comes, changes what this port answers; no expense refers to the member's
  membership afterwards, since an expense keeps its shares as recorded.

## When to revisit

When Ledger needs more than the current members of a group (for instance, when a member left, for a statement): the port
then grows a question of its own, and the map records it.
