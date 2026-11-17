# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-in-sqlite-with-its-aggregate-and-its-token.md) | Accounts: SQLite, the Account aggregate, and signed tokens |
| [3](0003-a-context-with-two-resources-mounts-at-the-root.md) | A context with two resources mounts its routes at the root, each with its full path |
| [4](0004-ledger-records-an-expense-split-by-the-groups-members.md) | Ledger records an expense split by the members Groups names, and how it reads them inside its transaction |
| [5](0005-a-groups-balances-are-read-from-ledgers-expenses.md) | A group's balances are read from Ledger's expenses, in one statement, members in the order they joined |
| [6](0006-an-expense-is-edited-and-deleted-by-its-payer-or-the-owner.md) | An expense is edited and deleted by its payer or the group's owner, from the version its author read |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
