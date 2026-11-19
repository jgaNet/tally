# 35. Spending insights: a query of Ledger over the shares, across the groups a person is in now, through its own ports

## Context

Request 37 (`api/37-spending-insights.yaml`) lets a signed-in person read what they spent across every group they are a member of now: for each
month, currency and category where their shares add up to more than 0, the sum of their shares of the groups' expenses of that category dated in
that month (UTC), each in its group's currency. Deleted expenses count for nothing, and so do groups the person has left. Each person reads their
own only. The API is `GET /v1/accounts/me/insights`, answered `200` with the lines, the earliest month first, then the currencies alphabetically,
then the categories in the order request 24 lists them.

The storm (`conventions/storms/spending-insights.yaml`) decided that Ledger answers it: the shares, the categories and the dates are Ledger's own,
so the answer is a query over Ledger's read model and nothing is kept. It decided that Ledger learns a person's groups and their currencies through
the two ports it already owns on Groups, `GroupMembers` and `GroupCurrency`, and that no new relationship and no copy of Groups' data is made. The
relationship Groups → Ledger is already in the context map (`owned-port`, `GroupCurrency` and `GroupMembers`).

## Decision

**A query, nothing kept.** `GetMyInsights` is a query of Ledger's Application (`Insights.ts`), built on three ports, and listed in Ledger's
`LiteModule`. It is answered at once through `answerAtOnce()` and needs a signed-in caller (the default). It changes nothing and opens no
transaction. No aggregate, no event, no integration event and no table is added.

**The groups, through `GroupMembers`.** `IGroupMembers` gains `groupsOf(accountId)`: the ids of the groups the account is a member of now, the most
recently created first. Its adapter, `GroupMembersOfGroups`, answers it over Groups' read model `groupsOf`, which already reads current membership
only (a member who left is removed from it). Ledger's Domain does not import Groups.

**The currency, through `GroupCurrency`.** The existing `IGroupCurrency.currencyOf(groupId, askedBy)` answers each group's currency, asked with the
person themselves, who is a member of every group in the list. Amounts are in the group's currency (request 21), so a currency is a property of the
group, not of the expense.

**The sums, in one query.** `IExpenseQueries.spendingOf(memberId, groupIds)` returns one row per group, month and category where the member has
shares, summing the member's shares of the group's expenses. The month is `substr(date, 1, 7)` of the expense's date, which is a UTC calendar date.
Deleted expenses are removed from the table when they are deleted, so they are not summed.

**The lines, in the use case.** The use case joins each group's currency to its rows, sums the rows that share a month, currency and category (several
groups in one currency add up), leaves out the lines that add up to 0, and orders the rest: months and currencies by their code units, categories by
`EXPENSE_CATEGORIES`. The order is written once, where the categories are.

## Consequences

- Ledger's `IGroupMembers` and its adapter each gain one method. No other context changes; the context map is unchanged and the storm carries nothing
  new.
- A call reads the person's groups, then each group's currency (one read per group), then the sums in one query. The reads are at a request, as the
  other Groups reads are (ADR 7). Should the number of groups grow, a batched currency answer is the change to make, in the same port.
- The route is `GET /accounts/me/insights` in Ledger's presentation, registered under `/v1` with the other Ledger routes. Its answer has the shape of
  `api/37-spending-insights.yaml`.
- A person's own spending is read by its owner only: the query takes the caller's id, and nothing in it names another account.

## Rejected alternatives

- **A read model kept up to date by events.** An `ExpenseRecorded` subscriber could keep a table of sums per person. The storm decided that nothing is
  kept, and a sum that every expense event moves is a second copy of the shares that must be kept in step with the balances, the edits and the deletes.
- **A new context for insights.** Only Ledger holds the shares, the categories and the dates, so a context of its own would add a relationship the storm
  does not need, and would copy what it reads.
- **Reading Groups' read model directly from Ledger's Domain.** The Domain may not import another context (CTX-CONTRACTS). The port Ledger owns is the
  one place it reads Groups, as it already reads the members and the currency.
- **Putting the groups and the currencies in one call to `GroupCurrency`.** The currency port answers for one group, as the other Ledger decisions
  ask it; a second answer about the groups of a person belongs with `GroupMembers`, which already answers who is in a group.
