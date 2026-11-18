# 28. Spending insights are a query of Ledger over its own shares, and the groups a person is in are read through the port Ledger owns

## Context

Request 37 lets a signed-in person read what they spent across every group they are a member of now: their shares, by
month, currency and category, the earliest month first. The storm (`conventions/storms/spending-insights.yaml`) decided two
hot spots before the code: the answer is Ledger's, because the shares, the categories and the dates are its own; and Ledger
learns a person's groups and their currencies through the two ports it already owns on Groups (`GroupMembers`,
`GroupCurrency`), with no new relationship and no copy of the membership.

The port `GroupMembers` answered membership of one group, not the groups of one account, so the storm's decision needs a
new answer from Groups. Nothing else changes: the context map keeps its Groups → Ledger link as declared.

## Decision

- **The query is Ledger's.** `GetMyInsights` (`GET /v1/accounts/me/insights`) is a query handler of Ledger, answered to the
  caller only: the handler asks for the caller's id and no other. Each caller reads their own shares.
- **Groups answers the groups an account is a member of now.** `IGroupMembersQueries.groupIdsOf(accountId)` lists the
  groups where the account has no departure, archived groups included (an archived group still holds what was spent in
  it). A merged group is gone from Groups' tables, and what it held is counted in the group it was merged into. Its adapter
  is Groups' read model, read outside any transaction like the other membership reads.
- **Ledger's ports carry it.** `IGroupMembers.groupsOf(accountId)` is the port Ledger owns on Groups for membership, answered
  by `GroupMembersFromGroups` over that read model. Each group's currency is read through `IGroupCurrency.currencyOf`, as
  the expense already reads it. No new port, no new contract name, no new relationship: the map stays as it is.
- **The sums are Ledger's read model.** `PostgresSpendingReadModels.sharesOf` sums the caller's shares per group, month and
  category over the expenses and their shares, which hold what is kept (a deleted expense has no row). The shares are in the
  group's currency, so a group's currency alone gives the currency of its line.
- **The lines are one pure rule.** `insightsOf` sums the groups' sums by month, currency and category, keeps only the lines
  that add up to more than 0, and orders them: month ascending, currency alphabetically, category in the order request 24
  gives. It is a function of what the read model and the ports answer, so it is tested without a database.

## Consequences

- A person in many groups costs one `currencyOf` read per group, inside the same request. That is cheap at the size the
  application has, and the simplest reading of the port; a batched currency read is the change to make when it is not.
- Membership is read at the moment of the request: a group left is gone from the answer at once, and a deleted expense is
  gone with its shares.
- Groups stays the only context that knows membership; Ledger keeps no copy of it.

## When to revisit

When a person's groups are many enough that one currency read per group is felt (then batch `currencyOf` on the port
Ledger owns), or when a spending view must include the expenses of groups a person has left (a new decision, since leaving
counts for nothing here).
