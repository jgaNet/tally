# 8. A group's expenses and a member's statement are read from Ledger's expenses, the statement's balance running in the read

## Context

Request 8 lets a member list the group's expenses, the latest date first, and read any member's statement: every expense the
member paid or is in the split of, the earliest date first, each with what the member paid, their share, and their balance once
the entry is counted. The storm (`conventions/storms/history-and-statement.yaml`) decided three things: Ledger answers both reads,
and asks Groups, through `GroupMembers` (ADR 4), whether the member has ever been one; "recorded" is the moment an expense was first
recorded, which an edit never changes; and the running balance is computed in the read model, at the read, with nothing stored per
entry.

Building it showed two things the storm did not say.

- **What "recorded" orders by.** An expense is a row, and an edit updates that row in place (ADR 0006), so the row's SQLite
  `rowid` is kept from the moment the expense is first inserted and never changes. Among the rows that exist, the rowid order is the
  order in which they were recorded, since a new row takes a rowid above every row that is there. A separate recorded-at column would
  need a migration of files already in use and a tie-break for two expenses with the same clock reading. Not taken.
- **The statement's balance and the group's balance.** A member's statement ends at the balance the group's balances give them
  (request 5), since both count the same expenses with the same signs: what the member paid, less their share. The statement is read
  in one statement, so the running balance and its last entry come from one snapshot.

## Decision

- **Two reads in Ledger's read model.** `IExpenseQueries.expensesOf(groupId)` answers the group's expenses, each as `GET
  /expenses/{id}` reads it, ordered by date descending and then by rowid descending. `IExpenseQueries.statementOf(groupId, memberId)`
  answers the member's entries, ordered by date ascending and then by rowid ascending, each with `paid`, `share` and a running `balance`
  computed by a window sum `SUM(paid - share) OVER (ORDER BY date, rowid)`. Both read inside `exclusive()`, one snapshot each.
- **Who reads.** `GetGroupExpenses` and `GetMemberStatement` need a signed-in caller who is a member of the group, asked of Groups
  through `GroupMembers`, as `GetExpense` is: for anyone else the group does not exist (`NotFound`, 404). `GetMemberStatement` answers
  `NotFound` for a member id that is not one of the group's members, so a statement of a stranger does not exist either.
- **The statement's balance.** It is the last entry's balance, or 0 when there is no entry, which is the balance the group's balances
  give the member. Nothing is stored per entry or per member.
- **Route at the root.** `GET /groups/:id/expenses` and `GET /groups/:id/members/:memberId/statement`, in Ledger's routes (ADR 3).

## Consequences

- No new context, relationship, aggregate, event or port beyond the two read methods: the `GroupMembers` link is already carried
  (ADR 4), and `conventions/domain.yaml` is unchanged.
- "Ever a member" is answered by the current members, as the balances answer them (ADR 5). This holds only while membership only grows;
  a member leaving (request 20) changes it, and the check must then ask whether the member has ever been one.
- The order of recording is the rowid's, and is kept by the store only while rows are updated in place. A store that rewrote a row on an
  edit (delete and insert) would move an edited expense to the top of the most-recently-recorded order. The repository's `save()`
  updates in place and must keep doing so.

## Alternatives

- **A recorded-at column.** It states the order in the table, but needs a migration of the files already in use and a tie-break for two
  expenses recorded at the same instant. Not taken; the rowid is the order without either.
- **Sort in the application.** The store would load every expense of the group to sort it. The order and the running balance are one
  query each in SQLite, read in one snapshot. Not taken.
- **Store a running balance per entry.** The storm decided against it: it would contend for a row per member and change on every edit.

## When to revisit

When request 20 lets a member leave: the "ever a member" check must then stop relying on current membership, and the statement must read
the membership in the same snapshot as the expenses, or the leave must refuse while a balance is non-zero (`MemberBalances`, ADR 1 T5).
