# 28. Spending insights: Ledger reads a person's shares across their groups, through its own ports on Groups

Status: accepted (request 37)

## Context

Request 37: a signed-in person reads what they spent across every group they are a member of now, for each month, currency and
category (request 24): the sum of their shares in the group's expenses of that category dated in that month, in UTC. A deleted
expense counts for nothing; an expense counts in its group's currency, whatever it was paid in (request 21); a group the person
has left counts for nothing. A line is kept where the shares add up to more than 0, the earliest month first, the currencies
alphabetically, the categories in the order of request 24. Each person reads their own.

The storm (`conventions/storms/spending-insights.yaml`) decided the hot spots before the run: Ledger answers it, as a query over
its own read model, with nothing kept; and it asks Groups through the two ports it already owns on Groups, GroupMembers and
GroupCurrency, which now also answer the groups an account is a member of now. The storm's `links` declare the owned-port
link Groups → Ledger, already carried by the context map. No context is new and no relationship is new.

## Decision

- **Ledger answers it, from its own tables.** The shares, the categories and the dates are Ledger's. `GetMyInsights`
  (`GET /v1/accounts/me/insights`) sums, in one SQL read over `ledger_expense_shares`, `ledger_expenses` and
  `ledger_expense_categories`, the caller's shares by group, month and category, for the groups given. Nothing is copied and
  nothing is kept: a deleted expense has no rows, and a merged or edited expense is what its rows say.
- **The groups come from GroupMembers.** `IGroupMembers` (Ledger's port) gains `groupsOf(accountId)`, answered by
  `GroupsMembers` over Groups' read side, `IGroupMembership.groupIdsOf`: the groups the account is a member of now (`left_at IS NULL`),
  archived or not. A group it has left is not among them.
- **The currency comes from GroupCurrency.** Ledger asks `currencyOf` for each of those groups, the currency Groups made it in.
  An expense's amount is already in the group's currency (request 21), so a line's amount needs no conversion; lines of
  different groups in one currency add up to one line.
- **The lines are the handler's.** The handler keeps the lines whose shares add up to more than 0 and orders them by month,
  currency and the category order of `CATEGORIES`. The read model is `InsightReadModel`; the port is `IInsightQueries`, its
  adapter `PostgresInsightQueries`, reading outside any transaction as the other queries do.
- **Who reads it.** The query needs a signed-in caller (`requireSignedIn`, 401 otherwise) and reads only that caller's shares.

## Consequences

- The owned port GroupMembers grows by one answer, and Groups' read side by one method; both are reads of membership that
  already exist, with no new table and no new event.
- A query reads each group's currency through one call per group. A person in a handful of groups is a handful of reads; a
  very large number of groups would be worth one batched read, which is not needed for this feature.
- Archived groups count: an archived group is read only, and what was spent in it is still what the person spent.

## When to revisit

When the insights must include spending that is not in a group's expenses (a settlement, a recurring expense not yet recorded),
when a person must see another person's insights (a shared household view, a new relationship decided by its own storm), or
when a person in very many groups makes the per-group currency reads slow.
