# 5. A group's balances are read from Ledger's expenses, in one statement, members in the order they joined

## Context

Request 5 lets a member read every member's balance in a group: what they paid for the group's expenses, less their
shares of them, in the order the members joined, the balances adding up to 0 whatever is recorded at once. The storm
(`conventions/storms/balances.yaml`) decided three things: the balances live in a read model of Ledger's own facts, with
no aggregate holding a running balance; the zero sum is kept by each expense's shares adding up to its amount; and the
members are Groups', read through `GroupMembers` (ADR 4). A query needs no decision of its own under the Lite profile,
but the read has two points the storm did not say.

- **Two reads, two connections.** The balances are read from Ledger's tables on the shared connection; the members are
  read through `GroupMembers`, which Groups answers on its own connection (ADR 4). Two reads on two connections are not
  one snapshot, so a member who joins between them and is in an expense recorded between them could be counted in the
  balances and missing from the list.
- **The read of a balance is one statement.** Balances are a sum over the group's expenses and their shares. A single
  statement in WAL mode reads one committed state, and the shared database's `exclusive()` waits for an open write
  transaction, so no half-written expense is read.

## Decision

- **A read model, not a store.** `IExpenseQueries.balancesOf(groupId)` answers, from Ledger's tables, what each member paid
  less their shares (`UNION ALL` of the payers' amounts and the negated shares, `GROUP BY member`). Nothing is stored,
  updated or aggregated outside the expense it counts, so twenty expenses at once on two servers contend for no row.
- **The balances are read before the members.** `GetGroupBalances` reads the balances, then `GroupMembers`. Membership
  only grows today, so the members read second include every member the first read counts: the listed balances
  add up to 0 exactly, and a member with nothing recorded is listed with 0. The reverse order could list fewer
  members than a balance counts.
- **A non-member does not see the group.** The caller must be a member, as in `GetExpense`; the group is otherwise
  `NotFound`, on the same port.
- **Route at the root.** `GET /groups/:id/balances`, in Ledger's routes, mounted at the API's root (ADR 3).

## Consequences

- No new context, relationship, aggregate or event: the feature uses the `GroupMembers` link already carried (ADR 4),
  and `conventions/domain.yaml` is unchanged.
- The zero sum holds in the code only while a member cannot leave a group with a share in it. A member leaving is a
  later feature (request 20; the `MemberBalances` link stays `planned`), and the ordering above is correct only while
  membership only grows.

## Alternatives

- **A balance per member, kept in a table and updated by each expense.** Each expense would contend for the same member's
  row across servers. Not taken; the storm decided against a running balance.
- **Read the members first, then the balances.** It lists members first, which is the natural order, but it can drop a
  member a concurrent expense has just counted. Not taken.
- **Read both on the shared connection.** Groups' members are in another context's tables, and Ledger may read them only
  through `GroupMembers` (ADR 1, T3). Not taken.

## When to revisit

When request 20 (a member leaving) lets membership shrink: then the members read must cover every member a balance counts
in the same snapshot, or the leave must refuse while a balance is non-zero, as `MemberBalances` (ADR 1, T5) decides.
