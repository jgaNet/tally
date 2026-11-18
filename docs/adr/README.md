# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-on-one-sqlite-file.md) | Accounts in Groups, and the application’s state in one SQLite file |
| [3](0003-ledger-asks-groups-who-may-be-in-a-split.md) | Ledger asks Groups who may be in a split (the Groups → Ledger link, carried) |
| [4](0004-a-transaction-reads-its-own-file.md) | A transaction reads its own file: its reads do not wait for the turn it holds |
| [5](0005-groups-asks-ledger-a-members-balance.md) | Groups asks Ledger a member’s balance (the Ledger → Groups link, carried); former members kept; the read model built by the composition root |
| [6](0006-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [7](0007-settlements-reads-balances-and-members-for-the-suggestion.md) | Settlements asks Ledger the balances and Groups the members (the Ledger → Settlements and Groups → Settlements links, carried) |
| [8](0008-settlement-book-and-ledger-counts-settlements.md) | A settlement is decided in its group’s book, and Ledger counts the settlements paid (the Settlements → Ledger link, carried) |
| [9](0009-notifications-tells-each-member-of-an-expense.md) | Notifications tells each member of an expense from Ledger’s ExpenseRecorded (the Ledger → Notifications link, carried); a notice made once from the fact |
| [10](0010-notifications-reminds-a-lingering-debt-from-settlements.md) | Notifications reminds a lingering debt, from a sweep that asks Settlements what is still owed (the Settlements → Notifications link, carried) |
| [11](0011-leaving-passes-the-balance-to-the-owner.md) | Leaving passes the balance to the owner, and a payment waiting at the provider refuses it (the Settlements → Groups link, carried) |
| [12](0012-ledger-converts-an-expense-paid-in-another-currency.md) | Ledger converts an expense paid in another currency at the rate its payer states, its group currency asked through a port (the Groups → Ledger link, carried) |
| [13](0013-ledger-offers-a-rate-from-a-rates-service.md) | Ledger offers the rate of a rates service, and an expense in another currency takes or corrects it, the rates service behind a port Ledger owns (the Groups → Ledger link, carried) |
| [14](0014-ledger-records-recurring-expenses-by-a-job-once-a-day.md) | Ledger records a recurring expense’s days by a background job, each day once, and its expense from the day’s fact (the Groups → Ledger link, carried) |
| [15](0015-ledger-passes-a-budget-once-a-month.md) | Ledger decides a passed budget once a month, and Notifications tells each member from BudgetPassed (the Ledger → Notifications link, carried) |
| [16](0016-ledger-keeps-split-templates-as-their-own-aggregate.md) | Ledger keeps a split template as its own aggregate, and an expense is split by its split, not a reference to it (the Groups → Ledger link, carried) |
| [17](0017-ledger-keeps-a-receipt-as-its-own-aggregate-in-an-outside-store.md) | Ledger keeps a receipt as its own aggregate, its file in an outside receipts store behind a port (no new context, no new relationship) |
| [19](0019-each-context-writes-its-audit-entries-and-ledger-reads-them.md) | Each context writes the audit entries of its own changes of money in their transaction, and Ledger reads them through two ports (no new context, no new relationship) |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
