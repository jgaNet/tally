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
| [7](0007-an-expense-is-split-equally-by-exact-amounts-or-by-shares.md) | An expense is split equally, by exact amounts or by shares, and says which |
| [8](0008-a-group-expenses-and-a-members-statement-are-read-from-ledgers-expenses.md) | A group's expenses and a member's statement are read from Ledger's expenses, the statement's balance running in the read |
| [9](0009-a-member-leaves-a-group-once-its-balance-is-zero.md) | A member leaves a group once its balance is 0, a former member keeps its place in the record, and the cross-context read models open at the composition root |
| [10](0010-the-remainder-of-a-split-goes-to-the-first-member-listed.md) | The remainder of an equal or shares split goes to the first member listed, whoever paid |
| [11](0011-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [12](0012-suggested-settlements-are-read-from-the-balances-and-the-members.md) | A suggestion of settlements is read from the balances and the members, and recorded nowhere |
| [13](0013-a-cash-settlement-is-recorded-in-the-groups-book-and-counted-by-the-balances.md) | A cash settlement is recorded in the group's book, and the balances count it at once |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.
